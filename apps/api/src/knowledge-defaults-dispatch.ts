import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { defaultKnowledgeFlagEnabled, recordDefaultKnowledgeIntent, type DefaultKnowledge } from '@tulipfarm/knowledge';
import { defaultKnowledgeWorkSchema, type DefaultKnowledgeWork } from '@tulipfarm/knowledge/default-contracts';
import type { DefaultKnowledgeHook } from '@tulipfarm/integrations/authorization';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { recordDispatchSkip } from '@tulipfarm/observability';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export async function startDefaultKnowledgeWorkflow(
  temporal: ReturnType<typeof createTemporalClient>,
  value: DefaultKnowledgeWork,
) {
  const work = defaultKnowledgeWorkSchema.parse(value);
  try {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('knowledgeDefaultsSync', {
        workflowId: `knowledge-defaults-${work.workspaceId}-${work.intentId}-${work.generation}`,
        taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-defaults`,
        args: [work],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      }),
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

/**
 * Integration services record intents before the defaults service exists, so starts bind late.
 * A missed start is recovered by the due-work sweep.
 */
export function defaultKnowledgeStarter(app: FastifyInstance, temporal?: ReturnType<typeof createTemporalClient>) {
  let service: Pick<DefaultKnowledge, 'due'> | undefined;
  async function start(workspaceId: string) {
    if (!service || !temporal) return;
    for (const work of await service.due(workspaceId)) await startDefaultKnowledgeWorkflow(temporal, work);
  }
  const hook: DefaultKnowledgeHook = {
    enabled: defaultKnowledgeFlagEnabled,
    record: recordDefaultKnowledgeIntent,
    started: workspaceId => {
      void start(workspaceId).catch(() => app.log.warn({ workspaceId }, 'Default Knowledge start will retry'));
    },
  };
  return {
    hook,
    start,
    attach(value: Pick<DefaultKnowledge, 'due'>) {
      service = value;
    },
  };
}

export function registerDefaultKnowledgeDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pick<Pool, 'query'>;
    service: Pick<DefaultKnowledge, 'due'>;
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
            await startDefaultKnowledgeWorkflow(dependencies.temporal, work);
          }
        } catch (error) {
          if (error instanceof StorageUnavailableError && error.code === 'incompatible_version')
            recordDispatchSkip('defaults');
          else app.log.error({ workspaceId: row.workspace_id }, 'Default Knowledge dispatch will retry');
        }
        after = row.workspace_id;
      }
      if (rows.length < 100) after = null;
    },
    'Default Knowledge discovery will retry',
    'knowledge-defaults-dispatch',
  );
}
