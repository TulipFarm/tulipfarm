import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { AtlassianKnowledge } from '@tulipfarm/knowledge';
import { atlassianKnowledgeWorkSchema, type AtlassianKnowledgeWork } from '@tulipfarm/knowledge/atlassian-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export async function startAtlassianKnowledgeWorkflow(
  temporal: ReturnType<typeof createTemporalClient>,
  value: AtlassianKnowledgeWork,
) {
  const work = atlassianKnowledgeWorkSchema.parse(value);
  try {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('atlassianKnowledgeSync', {
        workflowId: `knowledge-atlassian-${work.workspaceId}-${work.sourceId}-${work.generation}`,
        taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-atlassian`,
        args: [work],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      }),
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

export function registerAtlassianKnowledgeDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pick<Pool, 'query'>;
    service: Pick<AtlassianKnowledge, 'due'>;
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
            await startAtlassianKnowledgeWorkflow(dependencies.temporal, work);
          }
        } catch (error) {
          if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version'))
            app.log.error({ workspaceId: row.workspace_id }, 'Atlassian Knowledge dispatch will retry');
        }
        after = row.workspace_id;
      }
      if (rows.length < 100) after = null;
    },
    'Atlassian Knowledge discovery will retry',
    'knowledge-atlassian-dispatch',
  );
}
