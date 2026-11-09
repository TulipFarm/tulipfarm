import { Client, Connection } from '@temporalio/client';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import type { createFiles } from '@tulipfarm/files';
import {
  createPlanDocumentStore,
  type PlanDocumentError,
  type PlanDocumentMode,
  type PlanDocumentTarget,
} from '@tulipfarm/agents/plan-document-store';
import { planDocumentsEnabled } from '@tulipfarm/agents/plans';
import {
  planDocumentObjectPath,
  planDocumentRenderQueue,
  type PlanDocumentRenderResult,
} from '@tulipfarm/plan-documents';
import { retryError } from '@tulipfarm/observability';
import { workspaceSchemaPending } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';

type Objects = {
  read: (key: string, maximumBytes: number) => Promise<Uint8Array>;
  remove: (key: string) => Promise<void>;
};
type Profiles = {
  read(workspaceId: string, userIds: string[]): Promise<readonly { id: string; name: string }[]>;
};

/** Starts `planDocument` workflows. A newer rendering of the same plan replaces one still running. */
export function createPlanDocumentDispatcher(failure: (workspaceId: string, planId: string) => void) {
  const connection = Connection.lazy(temporalConnectionOptions());
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm';
  const renderQueue = planDocumentRenderQueue(process.env);
  return {
    async start(workspaceId: string, planId: string, mode: PlanDocumentMode = 'auto') {
      try {
        await connection.withDeadline(Date.now() + 5000, () =>
          client.workflow.start('planDocument', {
            workflowId: `plan-document:${workspaceId}:${planId}`,
            taskQueue,
            args: [workspaceId, planId, { mode, renderQueue }],
            workflowIdConflictPolicy: 'TERMINATE_EXISTING',
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          }),
        );
      } catch {
        // The rendering stays pending; the plan recovery sweep starts it again.
        failure(workspaceId, planId);
      }
    },
    close: () => connection.close(),
  };
}

const unmigrated = (error: unknown) => workspaceSchemaPending(error);

export function createPlanDocumentComposition(options: {
  runtime: WorkspaceRuntime;
  profiles: Profiles;
  files: ReturnType<typeof createFiles> | undefined;
  objects: Objects | undefined;
  start: (workspaceId: string, planId: string, mode?: PlanDocumentMode) => Promise<void>;
}) {
  const store = createPlanDocumentStore(options.runtime);
  const names = async (workspaceId: string, userIds: readonly string[]) => {
    const profiles = userIds.length ? await options.profiles.read(workspaceId, [...userIds]).catch(() => []) : [];
    return new Map(profiles.map(profile => [profile.id, profile.name]));
  };
  const objects = (workspaceId: string) => {
    const store = options.objects;
    if (!store) throw new Error('Plan documents need object storage');
    return {
      read: (key: string, size: number) => store.read(planDocumentObjectPath(workspaceId, key), size),
      remove: (key: string) => store.remove(planDocumentObjectPath(workspaceId, key)),
    };
  };

  return {
    /** Starts rendering the plan's current revision and approval when the workspace uses plan documents. */
    async dispatch(workspaceId: string, planId: string) {
      try {
        if (!(await planDocumentsEnabled(workspaceId))) return;
        if (await store.claim(workspaceId, planId)) await options.start(workspaceId, planId);
      } catch (error) {
        if (!unmigrated(error)) throw error;
      }
    },
    /** Starts renderings again whose workflow was lost. */
    async recover(workspaceId: string) {
      let stalled: string[];
      try {
        stalled = await store.stalled(workspaceId);
      } catch (error) {
        if (unmigrated(error)) return;
        throw error;
      }
      for (const planId of stalled) await options.start(workspaceId, planId);
    },
    activities: {
      async preparePlanDocument(workspaceId: string, planId: string, mode: PlanDocumentMode) {
        try {
          return await store.prepare(workspaceId, planId, mode, userIds => names(workspaceId, userIds));
        } catch (error) {
          throw retryError('plan-document-prepare-unavailable', error);
        }
      },
      async failPlanDocument(
        workspaceId: string,
        planId: string,
        at: PlanDocumentTarget,
        error: PlanDocumentError,
        html?: PlanDocumentRenderResult['html'],
      ) {
        await store.fail(workspaceId, planId, at, error, html);
      },
      async publishPlanDocument(
        workspaceId: string,
        planId: string,
        at: PlanDocumentTarget,
        result: PlanDocumentRenderResult & { stampTone: string },
      ) {
        if (!options.files) throw new Error('Plan documents need object storage');
        await store.publish(workspaceId, planId, at, result, options.files, objects(workspaceId));
      },
    },
  };
}
