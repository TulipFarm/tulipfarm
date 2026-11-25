import type { Pool } from 'pg';
import { releaseIdSchema } from '@tulipfarm/apps';
import { readReleaseFile } from '@tulipfarm/apps/host-header-publisher';
import { s3AppStorage } from '@tulipfarm/apps/sites';
import {
  closeRequestHandle,
  mintRequestHandle,
  readCurrentAppRoute,
  renewRequestHandle,
  requestHandleKey,
  sweepExpiredRequestHandles,
  type RequestHandleKey,
} from '@tulipfarm/apps/store';
import { appHost } from '@tulipfarm/extensions';
import { dataViewRelease } from '@tulipfarm/tables/data-view-store';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { PreviewStorage } from './preview-environment.ts';
import type { PublicAppsDependencies } from './public-apps.ts';

/**
 * Public app dependencies from the environment, or null when no apps domain is configured. Without workspace storage
 * the gateway cannot read data views, so no request gets a handle. With it, handles are signed with a key derived from
 * the workspace runtime key, and a missing key fails startup.
 */
export function publicAppsFromEnvironment(
  env: NodeJS.ProcessEnv,
  platform: Pick<Pool, 'query'>,
  storage: PreviewStorage | undefined,
): PublicAppsDependencies | null {
  const domain = env.TULIPFARM_APP_SITES_DOMAIN?.toLowerCase();
  if (!domain) return null;
  const bucket = env.TULIPFARM_OBJECT_STORAGE_APPS_BUCKET;
  const files = bucket ? s3AppStorage(objectStorageClient(env), bucket) : undefined;
  return {
    domain,
    route: name => readCurrentAppRoute(platform, name),
    // The registered host is read per call so the gateway can be built before extensions finish starting.
    host: { connect: (input, signal) => appHost().connect(input, signal) },
    // Static releases live in the apps bucket only when the built-in publisher stages them; otherwise this finds none.
    files: files && ((releaseId, path, signal) => readReleaseFile(files, releaseId, path, signal)),
    liveRequests: storage && liveRequests(platform, storage, requestHandleKey(env)),
  };
}

function liveRequests(
  platform: Pick<Pool, 'query'>,
  storage: PreviewStorage,
  key: RequestHandleKey,
): NonNullable<PublicAppsDependencies['liveRequests']> {
  return {
    store: {
      dataRelease: async app => {
        const release = await storage.runtime.transaction(app.workspaceId, commonCompatibility, tx =>
          dataViewRelease(tx, app.appId),
        );
        return release === null ? null : releaseIdSchema.parse(release);
      },
      mint: async request => (await mintRequestHandle(platform, key, request)).handle,
      renew: handle => renewRequestHandle(platform, handle),
      close: handle => closeRequestHandle(platform, handle),
      sweep: () => sweepExpiredRequestHandles(platform),
    },
  };
}
