import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { HostHeaderPublisher } from '@tulipfarm/apps/host-header-publisher';
import { s3AppStorage, selectAppPublisher } from '@tulipfarm/apps/sites';
import { appRepositories } from '@tulipfarm/apps/store';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import type { AppRouteDependencies } from './apps.ts';
import type { createTemporalClient } from './temporal.ts';

/**
 * App storage, source cache and publisher from the environment, or null without an apps bucket. The platform pool is
 * read late because the API opens it while it registers routes.
 */
export function appHostingFromEnvironment(env: NodeJS.ProcessEnv, platform: () => Pick<Pool, 'query'> | undefined) {
  const bucket = env.TULIPFARM_OBJECT_STORAGE_APPS_BUCKET;
  if (!bucket) return null;
  const client = objectStorageClient(env);
  const publisher = selectAppPublisher(env, s3AppStorage(client, bucket), {
    query: (text, values) => {
      const pool = platform();
      if (!pool) throw new Error('The platform database is unavailable');
      return pool.query(text, values);
    },
  });
  const sites = publisher && 'serve' in publisher ? (publisher as HostHeaderPublisher) : undefined;
  return {
    publisher,
    repositories: appRepositories({ root: join(tmpdir(), 'tulipfarm-api-apps'), storage: { client, bucket } }),
    sites: sites && { publisher: sites, domain: env.TULIPFARM_APP_SITES_DOMAIN!.trim().toLowerCase() },
  };
}

export function temporalAppWorkflows(
  temporal: Pick<ReturnType<typeof createTemporalClient>, 'client'>,
): AppRouteDependencies['start'] {
  return async (workflow, workflowId, input) => {
    await temporal.client.workflow.start(workflow, {
      workflowId,
      taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
      args: [input],
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
  };
}
