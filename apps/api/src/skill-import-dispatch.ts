import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { createSkillImports } from '@tulipfarm/agents/skill-imports';
import { createSkillObjects } from '@tulipfarm/agents/skill-objects';
import type { FileBytes } from '@tulipfarm/files';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { createTemporalClient } from './temporal.ts';

export function registerSkillImportDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    runtime: WorkspaceRuntime;
    temporal: ReturnType<typeof createTemporalClient>;
    objects: FileBytes;
  },
) {
  const imports = createSkillImports(dependencies.runtime);
  const packages = createSkillObjects(dependencies.runtime, dependencies.objects);
  let after: string | null = null;
  backgroundSweep(
    app,
    async stopped => {
      const workspaces = await readyWorkspaces(dependencies.pool, after, 100);
      for (const workspace of workspaces) {
        if (stopped()) return;
        try {
          await packages.sweep(workspace.workspace_id);
          for (const job of await imports.pending(workspace.workspace_id)) {
            await dependencies.temporal.connection.withDeadline(Date.now() + 10000, () =>
              dependencies.temporal.client.workflow.start('skillImport', {
                workflowId: `skill-import-v1-${workspace.workspace_id}-${job.id}`,
                taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                args: [workspace.workspace_id, job.id],
                workflowIdConflictPolicy: 'USE_EXISTING',
                workflowIdReusePolicy: 'ALLOW_DUPLICATE',
              }),
            );
          }
        } catch {
          app.log.error({ workspaceId: workspace.workspace_id }, 'Skill import dispatch will retry');
        }
        after = workspace.workspace_id;
      }
      if (workspaces.length < 100) after = null;
    },
    'Skill import discovery will retry',
    'skill-import-dispatch',
  );
}
