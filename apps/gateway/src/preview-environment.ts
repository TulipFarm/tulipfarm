import type { Pool } from 'pg';
import { readAppObject, readPreviewSession, readPreviewTarget, redeemPreviewTicket } from '@tulipfarm/apps/store';
import { AppHostUnavailableError, appHost } from '@tulipfarm/extensions';
import { isFeatureEnabled } from '@tulipfarm/observability';
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
  const domain = env.TULIPFARM_APP_PREVIEW_DOMAIN?.toLowerCase();
  const bucket = env.TULIPFARM_OBJECT_STORAGE_APPS_BUCKET;
  if (!domain || !bucket) return null;
  const objects = { client: objectStorageClient(env), bucket };
  const ready = () => {
    const found = storage();
    if (!found) throw new Error('Workspace storage is unavailable');
    return found;
  };
  return {
    domain,
    shellOrigin,
    redeem: (previewKey, ticket) => redeemPreviewTicket(ready().pool, previewKey, ticket),
    session: (previewKey, token) => readPreviewSession(ready().pool, previewKey, token),
    enabled: workspaceId => isFeatureEnabled('app-hosting', null, { id: workspaceId }),
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
