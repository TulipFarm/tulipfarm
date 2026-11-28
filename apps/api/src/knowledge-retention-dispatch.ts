import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { KnowledgeRetention } from '@tulipfarm/knowledge';
import { workspaceSchemaPending } from '@tulipfarm/workspace-storage/runtime';
import { isFeatureEnabled, recordDispatchSkip } from '@tulipfarm/observability';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

/** Retention is measured in days, so each workspace is checked for expired Knowledge only every 15 minutes. */
export const knowledgeRetentionIntervalMs = 15 * 60_000;
const page = 100;

export async function startKnowledgeRetentionWorkflow(
  temporal: ReturnType<typeof createTemporalClient>,
  workspaceId: string,
) {
  try {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('knowledgeRetentionPurge', {
        workflowId: `knowledge-retention-${workspaceId}`,
        taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge`,
        args: [{ workspaceId }],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      }),
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

/** Starts a workspace's retention purge when it has removed Knowledge whose retention has passed. */
export function registerKnowledgeRetentionDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pick<Pool, 'query'>;
    retention: Pick<KnowledgeRetention, 'pending'>;
    temporal: ReturnType<typeof createTemporalClient>;
    enabled?: (workspaceId: string) => Promise<boolean>;
  },
) {
  const enabled = dependencies.enabled ?? (id => isFeatureEnabled('knowledge-retention-purge', null, { id }));
  backgroundSweep(
    app,
    async stopped => {
      let after: string | null = null;
      for (;;) {
        const rows = await readyWorkspaces(dependencies.pool, after, page);
        for (const row of rows) {
          if (stopped()) return;
          try {
            if ((await enabled(row.workspace_id)) && (await dependencies.retention.pending(row.workspace_id)))
              await startKnowledgeRetentionWorkflow(dependencies.temporal, row.workspace_id);
          } catch (error) {
            if (workspaceSchemaPending(error)) recordDispatchSkip('knowledge-retention', error.code);
            else app.log.error({ workspaceId: row.workspace_id }, 'Knowledge retention dispatch will retry');
          }
          after = row.workspace_id;
        }
        if (rows.length < page) return;
      }
    },
    'Knowledge retention discovery will retry',
    'knowledge-retention-dispatch',
    { intervalMs: knowledgeRetentionIntervalMs },
  );
}
