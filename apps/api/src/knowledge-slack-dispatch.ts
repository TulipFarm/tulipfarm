import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { SlackKnowledge } from '@tulipfarm/knowledge';
import { slackKnowledgeWorkSchema, type SlackKnowledgeWork } from '@tulipfarm/knowledge/slack-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export async function startSlackKnowledgeWorkflow(
  temporal: ReturnType<typeof createTemporalClient>,
  value: SlackKnowledgeWork,
) {
  const work = slackKnowledgeWorkSchema.parse(value);
  try {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('slackKnowledgeSync', {
        workflowId: `knowledge-slack-${work.workspaceId}-${work.sourceId}-${work.generation}`,
        taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-slack`,
        args: [work],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      }),
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

export function registerSlackKnowledgeDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pick<Pool, 'query'>;
    service: Pick<SlackKnowledge, 'due'>;
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
            await startSlackKnowledgeWorkflow(dependencies.temporal, work);
          }
        } catch (error) {
          if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version'))
            app.log.error({ workspaceId: row.workspace_id }, 'Slack Knowledge dispatch will retry');
        }
        after = row.workspace_id;
      }
      if (rows.length < 100) after = null;
    },
    'Slack Knowledge discovery will retry',
    'knowledge-slack-dispatch',
  );
}
