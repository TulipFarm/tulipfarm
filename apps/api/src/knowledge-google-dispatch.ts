import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { GoogleKnowledge } from '@tulipfarm/knowledge';
import { googleKnowledgeWorkSchema, type GoogleKnowledgeWork } from '@tulipfarm/knowledge/google-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { recordDispatchSkip } from '@tulipfarm/observability';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export async function startGoogleKnowledgeWorkflow(
  temporal: ReturnType<typeof createTemporalClient>,
  value: GoogleKnowledgeWork,
) {
  const work = googleKnowledgeWorkSchema.parse(value);
  try {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('googleKnowledgeSync', {
        workflowId: `knowledge-google-${work.workspaceId}-${work.sourceId}-${work.generation}`,
        taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-google`,
        args: [work],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      }),
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

export function registerGoogleKnowledgeDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pick<Pool, 'query'>;
    service: Pick<GoogleKnowledge, 'due'>;
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
            await startGoogleKnowledgeWorkflow(dependencies.temporal, work);
          }
        } catch (error) {
          if (error instanceof StorageUnavailableError && error.code === 'incompatible_version')
            recordDispatchSkip('google');
          else app.log.error({ workspaceId: row.workspace_id }, 'Google Knowledge dispatch will retry');
        }
        after = row.workspace_id;
      }
      if (rows.length < 100) after = null;
    },
    'Google Knowledge discovery will retry',
    'knowledge-google-dispatch',
  );
}
