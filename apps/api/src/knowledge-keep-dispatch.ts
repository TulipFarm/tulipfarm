import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { KnowledgeKeepFeed } from '@tulipfarm/knowledge';
import { workspaceSchemaPending } from '@tulipfarm/workspace-storage/runtime';
import { recordDispatchSkip } from '@tulipfarm/observability';
import { backgroundSweep, readyWorkspaces, sweepIntervals } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export async function startKnowledgeKeepWorkflow(
  temporal: ReturnType<typeof createTemporalClient>,
  workspaceId: string,
) {
  try {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('knowledgeKeepSync', {
        workflowId: `knowledge-keep-${workspaceId}`,
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

/** Starts a workspace's Keep sync whenever Knowledge is due to be sent to Keep or forgotten there. */
export function registerKnowledgeKeepDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pick<Pool, 'query'>;
    feed: Pick<KnowledgeKeepFeed, 'pending'>;
    temporal: ReturnType<typeof createTemporalClient>;
  },
) {
  let after: string | null = null;
  backgroundSweep(
    app,
    async stopped => {
      const rows = await readyWorkspaces(dependencies.pool, after, 100);
      for (const row of rows) {
        if (stopped()) return;
        try {
          if (await dependencies.feed.pending(row.workspace_id))
            await startKnowledgeKeepWorkflow(dependencies.temporal, row.workspace_id);
        } catch (error) {
          if (workspaceSchemaPending(error)) recordDispatchSkip('keep-knowledge', error.code);
          else app.log.error({ workspaceId: row.workspace_id }, 'Knowledge Keep dispatch will retry');
        }
        after = row.workspace_id;
      }
      if (rows.length < 100) after = null;
    },
    'Knowledge Keep discovery will retry',
    'knowledge-keep-dispatch',
    { intervalMs: sweepIntervals.sync },
  );
}
