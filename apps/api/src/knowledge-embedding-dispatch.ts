import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { embeddingWorkSchema, type EmbeddingWork, type createKnowledgeEmbeddings } from '@tulipfarm/knowledge';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { recordDispatchSkip } from '@tulipfarm/observability';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export async function startKnowledgeEmbeddingWorkflow(
  temporal: ReturnType<typeof createTemporalClient>,
  value: EmbeddingWork,
) {
  const work = embeddingWorkSchema.parse(value);
  try {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('knowledgeEmbed', {
        workflowId: `knowledge-embedding-${work.workspaceId}-${work.jobId}${work.generation === undefined ? '' : `-${work.generation}`}`,
        taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-embeddings`,
        args: [work],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      }),
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

export function registerKnowledgeEmbeddingDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pick<Pool, 'query'>;
    service: Pick<ReturnType<typeof createKnowledgeEmbeddings>, 'due'>;
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
          for (const work of await dependencies.service.due(row.workspace_id)) {
            if (stopped()) return;
            await startKnowledgeEmbeddingWorkflow(dependencies.temporal, work);
          }
        } catch (error) {
          if (error instanceof StorageUnavailableError && error.code === 'incompatible_version')
            recordDispatchSkip('embedding');
          else app.log.error({ workspaceId: row.workspace_id }, 'Knowledge embedding dispatch will retry');
        }
        after = row.workspace_id;
      }
      if (rows.length < 100) after = null;
    },
    'Knowledge embedding discovery will retry',
    'knowledge-embedding-dispatch',
  );
}
