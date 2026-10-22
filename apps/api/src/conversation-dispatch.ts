import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import { createConversationDispatch } from '@tulipfarm/conversations/dispatch';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { createTemporalClient } from './temporal.ts';
import type { createAttachments } from '@tulipfarm/conversations/attachments';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { registerChatLatency } from './chat-latency.ts';
import { createConversationMaintenance } from '@tulipfarm/conversations/maintenance';
import { errorAttributes, log } from '@tulipfarm/observability';

// The send route does not await its start; these deadlines bound background work and shutdown, not the send.
const sendStartDeadlineMs = 2000;
const sweepStartDeadlineMs = 10000;

export type ReplyDispatch = ReturnType<typeof createReplyDispatch>;

export function createReplyDispatch(dependencies: {
  runtime: ConversationRuntime;
  temporal: Pick<ReturnType<typeof createTemporalClient>, 'connection' | 'client'>;
}) {
  const { temporal } = dependencies;
  const dispatch = createConversationDispatch({
    runtime: dependencies.runtime,
    start: async (work, source) => {
      const deadline = source === 'send' ? sendStartDeadlineMs : sweepStartDeadlineMs;
      await bounded(deadline, () =>
        temporal.connection.withDeadline(Date.now() + deadline, () =>
          temporal.client.workflow.start('conversationReply', {
            workflowId: `conversation-reply-v1-${work.workspaceId}-${work.turnId}-${work.generation}`,
            taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
            args: [work],
            workflowIdConflictPolicy: 'USE_EXISTING',
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          }),
        ),
      );
    },
  });
  const pending = new Set<Promise<void>>();
  return {
    dispatch,
    /** Call after the send commits and inside its request context; never throws, and the sweep recovers a failed start. */
    sent(workspaceId: string, conversationId: string) {
      const task: Promise<void> = dispatch(workspaceId, { conversationId, source: 'send' })
        .catch(error =>
          log('warn', 'dependency', 'dispatch_failed', {
            ...errorAttributes(error),
            'error.code': errorAttributes(error)['error.code'] ?? 'failed',
            operation: 'chat.dispatch',
            dispatch_source: 'send',
          }),
        )
        .finally(() => pending.delete(task));
      pending.add(task);
    },
    async settle() {
      await Promise.all(pending);
    },
  };
}

/**
 * `withDeadline` covers the RPC but not the lazy first connect (`connectTimeout`, 10s by default).
 * A start that lands after this bound is harmless: the workflow id is deterministic and reuses the run.
 */
async function bounded<T>(ms: number, call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
  });
  try {
    return await Promise.race([call(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function registerConversationDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    runtime: ConversationRuntime;
    temporal: ReturnType<typeof createTemporalClient>;
    attachments?: ReturnType<typeof createAttachments> | undefined;
    expireApprovals?: (workspaceId: string) => Promise<void>;
    replies: ReplyDispatch;
  },
) {
  const { pool, runtime, temporal, replies } = dependencies;
  app.addHook('onClose', () => replies.settle());
  registerChatLatency(app, pool, runtime);
  const requests = createConversationRequests(runtime);
  const maintenance = createConversationMaintenance(runtime);
  let after: string | null = null;
  async function sweep(stopped: () => boolean) {
    const rows = await readyWorkspaces(pool, after, 100);
    for (const row of rows) {
      if (stopped()) return;
      try {
        await requests.expire(row.workspace_id);
      } catch (error) {
        if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version'))
          app.log.error({ workspaceId: row.workspace_id }, 'Request expiry will retry');
      }
      try {
        await dependencies.expireApprovals?.(row.workspace_id);
      } catch (error) {
        if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version'))
          app.log.error({ workspaceId: row.workspace_id }, 'Approval expiry will retry');
      }
      try {
        await replies.dispatch(row.workspace_id);
      } catch {
        app.log.error({ workspaceId: row.workspace_id }, 'Conversation dispatch will retry');
      }
      try {
        if (stopped()) return;
        const outcome = await maintenance.sweep(row.workspace_id);
        if (outcome.closed || outcome.queued)
          app.log.info({ workspaceId: row.workspace_id, ...outcome }, 'Conversation maintenance sweep');
        await maintenance.dispatch(
          row.workspace_id,
          work =>
            temporal.connection.withDeadline(Date.now() + 10000, async () => {
              await temporal.client.workflow.start('conversationMaintenance', {
                workflowId: `conversation-maintenance-v1-${work.workspaceId}-${work.jobId}-${work.dispatchEpoch}`,
                taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                args: [work],
                workflowIdConflictPolicy: 'USE_EXISTING',
                workflowIdReusePolicy: 'ALLOW_DUPLICATE',
              });
            }),
          stopped,
        );
      } catch (error) {
        if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version'))
          app.log.error({ workspaceId: row.workspace_id }, 'Conversation maintenance will retry');
      }
      try {
        await dependencies.attachments?.cleanup(row.workspace_id);
      } catch {
        app.log.error({ workspaceId: row.workspace_id }, 'Attachment cleanup will retry');
      }
      after = row.workspace_id;
    }
    if (rows.length < 100) after = null;
  }
  backgroundSweep(app, sweep, 'Conversation discovery will retry', 'conversation-discovery');
}
