import { Context } from '@temporalio/activity';
import { Client, Connection } from '@temporalio/client';
import { planProviders, type PlanProvider } from '@tulipfarm/config';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import { createFileOutput, type FileOutputStore } from '@tulipfarm/conversations/file-outputs';
import type { ConversationRuntime, ResumeCodingRun } from '@tulipfarm/conversations/runtime';
import type { ExecutionBackend, ExecutionConfiguration } from '@tulipfarm/execution-contract';
import {
  codingRunLimitMs,
  createCodingRuns,
  type CodingRunServices,
  type CodingRuns,
} from '@tulipfarm/agents/coding-runs';
import {
  interruptCodingRun,
  proposeCodingRun,
  resumeCodingRun,
  runApprovedCodingRun,
} from '@tulipfarm/agents/coding-run-store';
import type { Subscriptions } from '@tulipfarm/integrations/subscriptions';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { githubChatReads } from './github-composition.ts';
import {
  isUnusablePlan,
  planCredentialsFromEnvironment,
  subscriptionsFromEnvironment,
  type PlanCredentials,
} from './member-plans.ts';

/** Coding runs for one chat runtime, with how a waiting run continues after its member's decision. */
export type ChatCodingRuns = CodingRuns & { resume: ResumeCodingRun };
export type CodingRunsFactory = (runtime: ConversationRuntime) => ChatCodingRuns | undefined;
/** Starts the workflow that runs an approved run; starting it again while it runs changes nothing. */
export type CodingRunStart = (workspaceId: string, runId: string) => Promise<void>;

export function codingRunServices(
  runtime: ConversationRuntime,
  options: {
    subscriptions?: Subscriptions;
    credentials?: (provider: PlanProvider) => PlanCredentials;
    github?: CodingRunServices['github'];
  } = {},
): CodingRunServices {
  const subscriptions = options.subscriptions ?? subscriptionsFromEnvironment(runtime);
  const cached: Partial<Record<PlanProvider, PlanCredentials>> = {};
  const credentials = (provider: PlanProvider) =>
    (cached[provider] ??= options.credentials?.(provider) ?? planCredentialsFromEnvironment(runtime, provider));
  const planOn = (workspaceId: string, provider: PlanProvider) =>
    isFeatureEnabled(planProviders[provider].flag, null, { id: workspaceId });
  let reads: ReturnType<typeof githubChatReads> | undefined;
  return {
    enabled: workspaceId => isFeatureEnabled('coding-runs', null, { id: workspaceId }),
    async hasPlan(workspaceId, membershipId, provider) {
      if (!(await planOn(workspaceId, provider))) return false;
      return (await subscriptions.eligible(workspaceId, provider, membershipId)).length > 0;
    },
    async plan(workspaceId, membershipId, provider) {
      if (!(await planOn(workspaceId, provider))) return null;
      for (const candidate of await subscriptions.eligible(workspaceId, provider, membershipId)) {
        try {
          const token = await credentials(provider).accessToken(workspaceId, candidate.ownerMembershipId);
          await subscriptions.markUsed(workspaceId, candidate.connectionId).catch(() => undefined);
          return { connectionId: candidate.connectionId, ownerMembershipId: candidate.ownerMembershipId, token };
        } catch (error) {
          if (!isUnusablePlan(error)) throw error;
        }
      }
      return null;
    },
    github:
      options.github ??
      ((workspaceId, actor, origin) => (reads ??= githubChatReads(runtime)).cloneToken(workspaceId, actor, origin)),
    propose: (workspaceId, run) => proposeCodingRun(runtime, workspaceId, run),
  };
}

export function codingRunsFactory(
  backend: ExecutionBackend,
  configuration: Exclude<ExecutionConfiguration, { mode: 'off' }>,
  start: CodingRunStart,
): CodingRunsFactory {
  return runtime => ({
    ...createCodingRuns(backend, configuration, codingRunServices(runtime)),
    async resume(context) {
      // A failed start leaves the run waiting; the chat checks it again on its next wake.
      const resumed = await resumeCodingRun(context.runtime, context.workspaceId, context.callId, () =>
        start(context.workspaceId, context.callId).catch(() => undefined),
      );
      return resumed.state === 'waiting' ? resumed : { ...resumed, sources: [] };
    },
  });
}

/** The activities that run approved coding runs, outside the chat reply and its shorter time limit. */
export function createCodingRunActivities(
  runtime: ConversationRuntime,
  backend: ExecutionBackend,
  configuration: Exclude<ExecutionConfiguration, { mode: 'off' }>,
  files: FileOutputStore | undefined,
) {
  const runs = createCodingRuns(backend, configuration, codingRunServices(runtime));
  return {
    async runCodingRun(workspaceId: string, runId: string) {
      const context = Context.current();
      const heartbeat = setInterval(() => context.heartbeat(), 20_000);
      try {
        await runApprovedCodingRun(runtime, workspaceId, runId, codingRunLimitMs, async run => {
          const result = await runs.execute(workspaceId, run, context.cancellationSignal);
          if (!('fullDiff' in result)) return result;
          const { fullDiff, ...shown } = result;
          if (!fullDiff || !files) return shown;
          const saved = await createFileOutput(
            files,
            { workspaceId, actor: run.actor, autonomous: false, origin: { turnId: run.turnId } },
            {
              tool: 'files.create',
              name: `${run.repository.replace('/', '-')}-diff-${run.id.slice(0, 8)}`,
              format: 'txt',
              content: fullDiff,
            },
          );
          return { ...shown, diffFile: 'file' in saved ? saved.file : saved };
        });
      } finally {
        clearInterval(heartbeat);
      }
    },
    interruptCodingRun: (workspaceId: string, runId: string) => interruptCodingRun(runtime, workspaceId, runId),
  };
}

/** Starts one `codingRun` workflow per run. */
export function createCodingRunDispatcher() {
  const connection = Connection.lazy(temporalConnectionOptions());
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm';
  const start: CodingRunStart = async (workspaceId, runId) => {
    await connection.withDeadline(Date.now() + 5000, () =>
      client.workflow.start('codingRun', {
        workflowId: `coding-run-v1-${workspaceId}-${runId}`,
        taskQueue,
        args: [workspaceId, runId],
        workflowIdConflictPolicy: 'USE_EXISTING',
        // A run is claimed once, so starting again after a lost workflow is safe.
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      }),
    );
  };
  return { start, close: () => connection.close() };
}
