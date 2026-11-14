import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AppId } from '@tulipfarm/apps';
import {
  admitPreview,
  issuePreviewTicket,
  readAppObject,
  readPreviewBuild,
  readPreviewSession,
  redeemPreviewTicket,
  registerPreviewHost,
  type AppTransaction,
} from '@tulipfarm/apps/store';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import { commonCompatibility, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { previewEnterPath, type PreviewGatewayDependencies } from './app-preview.ts';
import type { registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';

type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export type PreviewStorage = { readonly pool: Pick<Pool, 'query'>; readonly runtime: Runtime };

const enabled = (workspaceId: string) => isFeatureEnabled('app-hosting', null, { id: workspaceId });

const workspace = <T>(runtime: Runtime, workspaceId: string, action: (tx: AppTransaction) => Promise<T>) =>
  runtime.transaction(workspaceId, commonCompatibility, action);

/**
 * Gateway dependencies from the environment, or null when previews are not configured. Storage is read late because
 * the API opens its pools while it registers routes.
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
    enabled,
    build: session => workspace(ready().runtime, session.workspaceId, tx => readPreviewBuild(tx, session)),
    object: key => readAppObject(objects, key),
  };
}

const params = z.object({ workspaceId: z.uuid(), appId: z.uuid() });

/** Issues the one-time ticket an editor's browser posts to the preview host to open a preview session. */
export function registerPreviewTickets(
  app: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  storage: PreviewStorage,
  domain: string,
) {
  app.post(
    // oxlint-disable-next-line tulipfarm/product-copy -- A stable route, not user-facing copy.
    '/workspaces/:workspaceId/apps/:appId/preview-tickets',
    { schema: { operationId: 'createAppPreviewTicketV1', hide: true } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const parsed = params.safeParse(request.params);
      if (!parsed.success || !(await enabled(parsed.data.workspaceId)))
        return reply.code(404).send({ error: 'not-found' });
      const workspaceId = parsed.data.workspaceId.toLowerCase();
      const appId = parsed.data.appId.toLowerCase() as AppId;
      try {
        const admitted = await workspace(storage.runtime, workspaceId, tx => admitPreview(tx, appId, session.user.id));
        if (!admitted.ok)
          return reply
            .code(admitted.failure.code === 'forbidden' ? 403 : 404)
            .send({ failure: { name: 'AppFailure', code: admitted.failure.code, message: admitted.failure.message } });
        await registerPreviewHost(storage.pool, { previewKey: admitted.previewKey, workspaceId, appId });
        const { ticket } = await issuePreviewTicket(storage.pool, {
          previewKey: admitted.previewKey,
          authSessionId: session.session.id,
          membershipId: admitted.membershipId,
        });
        return { ticket, entryUrl: `https://${admitted.previewKey}.${domain}${previewEnterPath}` };
      } catch (error) {
        if (requestBoundaryError(error, reply)) return reply;
        throw error;
      }
    },
  );
}
