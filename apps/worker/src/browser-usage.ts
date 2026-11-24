import { Runtime } from '@temporalio/worker';
import type { BrowserMeter } from '@tulipfarm/agents/task-runtime';
import type { BrowserSessionState } from '@tulipfarm/browser';
import { creditGate, resourceMeter } from '@tulipfarm/extensions';
import { errorAttributes } from '@tulipfarm/observability';
import { knowledgeTaskSpend } from '@tulipfarm/workspace-storage/knowledge-credits';
import {
  browserUsageCompatibility,
  endBrowserUsage,
  recordBrowserUsage,
} from '@tulipfarm/workspace-storage/resource-credits';
import { qualified, type SqlClient } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';

type Transaction = { client: SqlClient; schema: string; commonVersion?: number };
type WorkspaceRuntime = {
  transaction<T>(
    workspaceId: string,
    compatibility: { readonly minimum: number; readonly maximum: number },
    action: (tx: Transaction) => Promise<T>,
  ): Promise<T>;
};

const unitsPerCredit = 1_000_000_000_000n;

function logger() {
  try {
    return Runtime.instance().logger;
  } catch {
    return console;
  }
}

/**
 * A session's browser meter, charging its time to `flow`. Without a registered resource meter, nothing is metered and
 * no browser is refused for credits. Recording never fails a browser step: a lost record is charged up to when the
 * host would have closed the session, from the last record.
 */
function meterFor(
  runtime: WorkspaceRuntime,
  input: {
    workspaceId: string;
    sessionId: string;
    /** The flow the session is charged to, if it still exists. */
    flow: (tx: Transaction) => Promise<string | undefined>;
    /** Whether the flow has used its credit allowance. */
    allowanceUsed?: (tx: Transaction) => Promise<boolean>;
  },
): BrowserMeter | undefined {
  if (!resourceMeter()) return undefined;
  const transact = <T>(action: (tx: Transaction) => Promise<T>) =>
    runtime.transaction(input.workspaceId, browserUsageCompatibility, action);
  const quietly = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      logger().error(`Browser time could not be ${what}`, {
        workspaceId: input.workspaceId,
        ...errorAttributes(error),
      });
    }
  };
  return {
    async admit() {
      try {
        return await transact(async tx => {
          const available = await creditGate().available(tx);
          if (available !== null && available <= 0n) return 'out-of-credits' as const;
          return (await input.allowanceUsed?.(tx)) ? ('allowance-used' as const) : undefined;
        });
      } catch (error) {
        // A failed check never keeps the browser closed; the session is still charged.
        logger().error('Browser credits could not be checked', {
          workspaceId: input.workspaceId,
          ...errorAttributes(error),
        });
        return undefined;
      }
    },
    record: (state: BrowserSessionState) =>
      quietly('recorded', async () => {
        const { openedAt, activeAt, closesAt } = state;
        if (!openedAt || !activeAt || !closesAt) return;
        await transact(async tx => {
          const flowId = await input.flow(tx);
          await recordBrowserUsage(tx, {
            sessionId: input.sessionId,
            openedAt: new Date(openedAt),
            closesAt: new Date(closesAt),
            at: new Date(activeAt),
            flowId,
          });
        });
      }),
    end: () => quietly('ended', () => transact(tx => endBrowserUsage(tx, input.sessionId, new Date()))),
  };
}

/** Meters a chat's browser in the chat's own flow. */
export function chatBrowserMeter(runtime: WorkspaceRuntime) {
  return (origin: { workspaceId: string; conversationId: string; sessionId: string }) =>
    meterFor(runtime, {
      workspaceId: origin.workspaceId,
      sessionId: origin.sessionId,
      flow: async () => origin.conversationId,
    });
}

const taskRow = z.object({ flow_id: z.string(), limits: z.object({ credits: z.number().int().nonnegative() }) });

async function task(tx: Transaction, taskId: string) {
  const row = (
    await tx.client.query(`SELECT flow_id,limits FROM ${qualified(tx.schema, 'tf_agent_tasks')} WHERE id=$1`, [taskId])
  ).rows[0];
  return row ? taskRow.parse(row) : undefined;
}

/** Meters an agent task's browser in the task's flow, and refuses a new browser once the task used its allowance. */
export function taskBrowserMeter(runtime: WorkspaceRuntime) {
  return (run: { workspaceId: string; taskId: string; sessionId: string }) =>
    meterFor(runtime, {
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      flow: async tx => (await task(tx, run.taskId))?.flow_id,
      allowanceUsed: async tx => {
        const found = await task(tx, run.taskId);
        if (!found) return false;
        const { spent } = z
          .object({ spent: z.string() })
          .parse(
            (
              await tx.client.query(
                `SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text AS spent FROM ${qualified(tx.schema, 'tf_credit_usage')} WHERE flow_id=$1`,
                [found.flow_id],
              )
            ).rows[0],
          );
        const used = BigInt(spent) + (await knowledgeTaskSpend(tx, found.flow_id));
        return used >= BigInt(found.limits.credits) * unitsPerCredit;
      },
    });
}
