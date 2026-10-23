import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { GitHubKnowledge } from '@tulipfarm/knowledge';
import { githubKnowledgeWorkSchema, type GitHubKnowledgeWork } from '@tulipfarm/knowledge/github-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { createKnowledgeSyncMetrics, recordDispatchSkip } from '@tulipfarm/observability';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export async function startGitHubKnowledgeWorkflow(
  temporal: ReturnType<typeof createTemporalClient>,
  value: GitHubKnowledgeWork,
) {
  const work = githubKnowledgeWorkSchema.parse(value);
  try {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('githubKnowledgeSync', {
        workflowId: `knowledge-github-${work.workspaceId}-${work.sourceId}-${work.generation}`,
        taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-github`,
        args: [work],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      }),
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

export function registerGitHubKnowledgeDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pick<Pool, 'query'>;
    service: Pick<GitHubKnowledge, 'due' | 'health'>;
    temporal: ReturnType<typeof createTemporalClient>;
  },
) {
  let after: string | null = null;
  const monitoring = createKnowledgeSyncMetrics();
  const empty = () => ({
    failedItems: 0,
    failedSources: 0,
    stalledSources: 0,
    reconnectSources: 0,
    permissionRepositories: 0,
    lostRepositories: 0,
  });
  let snapshot = empty();
  let scanFailed = false;
  app.addHook('onClose', async () => monitoring.close());
  backgroundSweep(
    app,
    async stopped => {
      const rows = await readyWorkspaces(dependencies.pool, after, 100);
      for (const row of rows) {
        if (stopped()) return;
        try {
          const health = await dependencies.service.health(row.workspace_id);
          for (const key of Object.keys(snapshot) as (keyof typeof snapshot)[]) snapshot[key] += health[key];
          for (const work of await dependencies.service.due(row.workspace_id)) {
            if (stopped()) return;
            await startGitHubKnowledgeWorkflow(dependencies.temporal, work);
          }
        } catch (error) {
          scanFailed = true;
          if (error instanceof StorageUnavailableError && error.code === 'incompatible_version')
            recordDispatchSkip('github');
          else app.log.error({ workspaceId: row.workspace_id }, 'GitHub Knowledge dispatch will retry');
        }
        after = row.workspace_id;
      }
      if (rows.length < 100) {
        if (!scanFailed) monitoring.publish(snapshot);
        after = null;
        snapshot = empty();
        scanFailed = false;
      }
    },
    'GitHub Knowledge discovery will retry',
    'knowledge-github-dispatch',
  );
}
