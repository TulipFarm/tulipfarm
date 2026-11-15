import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AccessDenied } from '@tulipfarm/access';
import { SystemPackageError, type createSystemPackages } from '@tulipfarm/agents/system-packages';
import { errorAttributes } from '@tulipfarm/observability';
import { backgroundSweep, readyWorkspaces, sweepIntervals } from './background-sweep.ts';

/** Resumes pending package installations in every ready workspace. */
export function registerSystemPackageSweep(
  app: FastifyInstance,
  pool: Pool,
  service: ReturnType<typeof createSystemPackages>,
) {
  let after: string | null = null;
  backgroundSweep(
    app,
    async stopped => {
      const workspaces = await readyWorkspaces(pool, after, 20);
      for (const workspace of workspaces) {
        if (stopped()) return;
        try {
          for (const installation of await service.pending(workspace.workspace_id)) {
            if (stopped()) return;
            try {
              await service.resume(workspace.workspace_id, installation.user_id, installation.id, {
                expectedVersion: installation.version,
              });
            } catch (error) {
              if (
                !(error instanceof AccessDenied) &&
                !(error instanceof SystemPackageError && error.code === 'installation-version-conflict')
              )
                app.log.error(
                  { workspaceId: workspace.workspace_id, ...errorAttributes(error) },
                  'Package installation will retry',
                );
            }
          }
        } catch (error) {
          app.log.error(
            { workspaceId: workspace.workspace_id, ...errorAttributes(error) },
            'Package installation discovery will retry',
          );
        }
        after = workspace.workspace_id;
      }
      if (workspaces.length < 20) after = null;
    },
    'Package installation discovery will retry',
    'system-package-dispatch',
    { intervalMs: sweepIntervals.recovery },
  );
}
