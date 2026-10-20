import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { backgroundSweeps, readyWorkspaces } from './background-sweep.ts';
import { WorkflowNotFoundError } from '@temporalio/client';
import type { createWorkflows } from '@tulipfarm/workflows';
import { businessWorkflowId, wakeSignal, type Work } from '@tulipfarm/workflows/contracts';
import type { createTemporalClient } from './temporal.ts';

export function workflowWake(app: FastifyInstance, temporal: ReturnType<typeof createTemporalClient>) {
  return async (work: Work) => {
    try {
      await temporal.connection.withDeadline(Date.now() + 5000, () =>
        temporal.client.workflow.getHandle(businessWorkflowId(work)).signal(wakeSignal),
      );
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError))
        app.log.error(
          { err: error, runId: work.runId },
          'Workflow wake will retry from the sweep or when its timer fires',
        );
    }
  };
}

export function registerWorkflowDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    service: ReturnType<typeof createWorkflows>;
    temporal: ReturnType<typeof createTemporalClient>;
  },
) {
  const wake = workflowWake(app, dependencies.temporal);
  let after: string | null = null;
  let providerAfter: string | null = null;
  async function providerSweep(stopped: () => boolean) {
    const rows = await readyWorkspaces(dependencies.pool, providerAfter, 10);
    for (let index = 0; index < rows.length && !stopped(); index += 2) {
      await Promise.all(
        rows.slice(index, index + 2).map(async row => {
          try {
            await dependencies.service.providers.poll(row.workspace_id);
          } catch {
            app.log.error({ workspaceId: row.workspace_id }, 'Provider discovery will retry');
          }
        }),
      );
    }
    providerAfter = rows.length === 10 ? (rows.at(-1)?.workspace_id ?? null) : null;
  }
  async function sweep(stopped: () => boolean) {
    const rows = await readyWorkspaces(dependencies.pool, after, 100);
    for (const row of rows) {
      if (stopped()) return;
      try {
        for (const work of await dependencies.service.due(row.workspace_id)) {
          try {
            await dependencies.temporal.connection.withDeadline(Date.now() + 10000, () =>
              dependencies.temporal.client.workflow.start('businessWorkflowV1', {
                workflowId: businessWorkflowId(work),
                taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                args: [work],
                workflowIdConflictPolicy: 'USE_EXISTING',
                workflowIdReusePolicy: 'ALLOW_DUPLICATE',
              }),
            );
          } catch {
            app.log.error({ runId: work.runId }, 'Workflow dispatch will retry');
          }
        }
        for (const work of await dependencies.service.resumable(row.workspace_id)) await wake(work);
      } catch {
        app.log.error({ workspaceId: row.workspace_id }, 'Workflow discovery will retry');
      }
      after = row.workspace_id;
    }
    if (rows.length < 100) after = null;
  }
  backgroundSweeps(app, [
    { run: sweep, failure: 'Workflow sweep will retry', job: 'workflow-dispatch' },
    { run: providerSweep, failure: 'Provider sweep will retry', job: 'provider-dispatch' },
  ]);
}
