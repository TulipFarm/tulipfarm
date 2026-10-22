import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createRecommendationWork } from '@tulipfarm/recommendations/work';
import { recommendationEligibility } from '@tulipfarm/recommendations/configuration';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { createTemporalClient } from './temporal.ts';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';

export function registerRecommendationDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    runtime: WorkspaceRuntime;
    temporal: ReturnType<typeof createTemporalClient>;
  },
) {
  const work = createRecommendationWork(dependencies.runtime);
  const eligible = recommendationEligibility(dependencies.pool);
  let after: string | null = null;
  const memberCursors = new Map<string, string>();
  backgroundSweep(
    app,
    async stopped => {
      const workspaces = await readyWorkspaces(dependencies.pool, after, 100);
      for (const row of workspaces) {
        if (stopped()) return;
        try {
          await work.compactEvents(row.workspace_id);
          await work.expireInvitations(row.workspace_id);
          const members = await work.pending(row.workspace_id, memberCursors.get(row.workspace_id) ?? null);
          for (const member of members) {
            if (stopped()) return;
            if (!(await eligible(row.workspace_id, member.userId))) continue;
            try {
              await dependencies.temporal.connection.withDeadline(Date.now() + 10_000, () =>
                dependencies.temporal.client.workflow.signalWithStart('rebuildRecommendations', {
                  workflowId: `recommendations-v1-${row.workspace_id}-${member.membershipId}`,
                  taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-recommendations`,
                  args: [row.workspace_id, member.membershipId],
                  signal: 'wakeRecommendations',
                  signalArgs: [],
                  workflowIdConflictPolicy: 'USE_EXISTING',
                  workflowIdReusePolicy: 'ALLOW_DUPLICATE',
                }),
              );
              app.log.info(
                {
                  workspaceId: row.workspace_id,
                  membershipId: member.membershipId,
                  queueAgeMs: Math.max(0, Date.now() - member.queuedAt.getTime()),
                },
                'Recommendation work dispatched',
              );
            } catch {
              app.log.error(
                { workspaceId: row.workspace_id, membershipId: member.membershipId },
                'Recommendation member delivery will retry',
              );
            }
          }
          if (members.length === 100) memberCursors.set(row.workspace_id, members.at(-1)!.membershipId);
          else memberCursors.delete(row.workspace_id);
        } catch {
          app.log.error({ workspaceId: row.workspace_id }, 'Recommendation delivery will retry');
        }
        after = row.workspace_id;
      }
      if (workspaces.length < 100) after = null;
    },
    'Recommendation queue discovery will retry',
    'recommendation-dispatch',
  );
}
