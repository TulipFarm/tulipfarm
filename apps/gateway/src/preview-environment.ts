import type { Pool } from 'pg';
import { previewHosts } from '@tulipfarm/apps';
import { readAppObject, readPreviewSession, readPreviewTarget, redeemPreviewTicket } from '@tulipfarm/apps/store';
import { AppHostUnavailableError, appHost } from '@tulipfarm/extensions';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import { commonCompatibility, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import type { PreviewGatewayDependencies } from './preview.ts';

export type PreviewStorage = {
  readonly pool: Pick<Pool, 'query'>;
  readonly runtime: Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
};

/**
 * Gateway dependencies from the environment, or null when previews are not configured. Storage is read late because
 * a host server may open its pools after it builds the gateway.
 */
export function previewGatewayFromEnvironment(
  env: NodeJS.ProcessEnv,
  shellOrigin: string,
  storage: () => PreviewStorage | undefined,
): PreviewGatewayDependencies | null {
  const bucket = env.TULIPFARM_OBJECT_STORAGE_APPS_BUCKET;
  if (!env.TULIPFARM_APP_PREVIEW_DOMAIN?.trim() || !bucket) return null;
  const { domain, prefix } = previewHosts(env.TULIPFARM_APP_PREVIEW_DOMAIN, env.TULIPFARM_APP_SITES_DOMAIN);
  const objects = { client: objectStorageClient(env), bucket };
  const ready = () => {
    const found = storage();
    if (!found) throw new Error('Workspace storage is unavailable');
    return found;
  };
  return {
    domain,
    prefix,
    shellOrigin,
    redeem: (previewKey, ticket) => redeemPreviewTicket(ready().pool, previewKey, ticket),
    session: (previewKey, token) => readPreviewSession(ready().pool, previewKey, token),
    target: session =>
      ready().runtime.transaction(session.workspaceId, commonCompatibility, tx => readPreviewTarget(tx, session)),
    object: key => readAppObject(objects, key),
    async connectHost(input, signal) {
      const host = appHost();
      if (!host.connectHost) throw new AppHostUnavailableError();
      return host.connectHost(input, signal);
    },
  };
}
