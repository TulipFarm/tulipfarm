import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { createGmailHeartbeat } from '@tulipfarm/google-workspace/heartbeat';
import type { HeartbeatWork } from '@tulipfarm/google-workspace/heartbeat-contracts';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export async function dispatchGmailHeartbeat(
  service: Pick<ReturnType<typeof createGmailHeartbeat>, 'due'>,
  workspaceId: string,
  start: (work: HeartbeatWork) => Promise<void>,
) {
  for (const work of await service.due(workspaceId)) await start(work);
}
export function registerGoogleHeartbeatDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    service: ReturnType<typeof createGmailHeartbeat>;
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
          await dispatchGmailHeartbeat(dependencies.service, row.workspace_id, async work => {
            await dependencies.temporal.connection.withDeadline(Date.now() + 10000, () =>
              dependencies.temporal.client.workflow.start('gmailHeartbeat', {
                workflowId: `gmail-heartbeat-v1-${work.workspaceId}-${work.heartbeatId}`,
                taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                args: [work],
                workflowIdConflictPolicy: 'USE_EXISTING',
                workflowIdReusePolicy: 'ALLOW_DUPLICATE',
              }),
            );
          });
        } catch {
          app.log.error({ workspaceId: row.workspace_id }, 'Gmail heartbeat discovery will retry');
        }
        after = row.workspace_id;
      }
      if (rows.length < 100) after = null;
    },
    'Gmail heartbeat discovery will retry',
    'google-heartbeat-dispatch',
  );
}
