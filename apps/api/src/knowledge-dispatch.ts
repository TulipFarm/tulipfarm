import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { knowledgeWorkSchema, type createLocalKnowledge, type KnowledgeWork } from '@tulipfarm/knowledge';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export async function startKnowledgeWorkflow(temporal: ReturnType<typeof createTemporalClient>, value: KnowledgeWork) {
  const work = knowledgeWorkSchema.parse(value);
  try {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('knowledgeIngest', {
        workflowId: `knowledge-${work.workspaceId}-${work.revisionId}-${work.generation}`,
        taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge`,
        args: [work],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      }),
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

export async function dispatchKnowledge(
  service: Pick<ReturnType<typeof createLocalKnowledge>, 'due' | 'acknowledge'>,
  workspaceId: string,
  start: (work: KnowledgeWork) => Promise<void>,
  stopped: () => boolean = () => false,
) {
  for (const work of await service.due(workspaceId)) {
    if (stopped()) return;
    await start(work);
    await service.acknowledge(work);
  }
}

export function registerKnowledgeDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pick<Pool, 'query'>;
    service: ReturnType<typeof createLocalKnowledge>;
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
          await dispatchKnowledge(
            dependencies.service,
            row.workspace_id,
            work => startKnowledgeWorkflow(dependencies.temporal, work),
            stopped,
          );
        } catch (error) {
          if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version'))
            app.log.error({ workspaceId: row.workspace_id }, 'Knowledge dispatch will retry');
        }
        after = row.workspace_id;
      }
      if (rows.length < 100) after = null;
    },
    'Knowledge discovery will retry',
    'knowledge-dispatch',
  );
}
