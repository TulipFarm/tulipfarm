import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { previewHostOf, type AppId, type PreviewHosts } from '@tulipfarm/apps';
import { admitPreview, issuePreviewTicket, registerPreviewHost, requestDraftHost } from '@tulipfarm/apps/store';
import { previewEnterPath } from '@tulipfarm/gateway/preview';
import type { PreviewStorage } from '@tulipfarm/gateway/preview-environment';
import { errorAttributes, isFeatureEnabled } from '@tulipfarm/observability';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { AppRouteDependencies } from './apps.ts';
import type { registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';
import { requestSession } from './request-session.ts';

const enabled = (workspaceId: string) => isFeatureEnabled('app-hosting', null, { id: workspaceId });

const params = z.object({ workspaceId: z.uuid(), appId: z.uuid() });

/**
 * Issues the one-time ticket an editor's browser posts to the preview host to open a preview session. Opening the draft
 * of a server app also starts its draft host when it needs one. A start that fails is logged and does not fail the
 * ticket; the next open after the start counts as lost starts it again.
 */
export function registerPreviewTickets(
  app: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  storage: PreviewStorage,
  hosts: PreviewHosts,
  start: AppRouteDependencies['start'],
) {
  app.post(
    // oxlint-disable-next-line tulipfarm/product-copy -- A stable route, not user-facing copy.
    '/workspaces/:workspaceId/apps/:appId/preview-tickets',
    { schema: { operationId: 'createAppPreviewTicketV1', hide: true } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const session = await requestSession(request, auth);
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const parsed = params.safeParse(request.params);
      if (!parsed.success || !(await enabled(parsed.data.workspaceId)))
        return reply.code(404).send({ error: 'not-found' });
      const workspaceId = parsed.data.workspaceId.toLowerCase();
      const appId = parsed.data.appId.toLowerCase() as AppId;
      try {
        const admitted = await storage.runtime.transaction(workspaceId, commonCompatibility, async tx => {
          const found = await admitPreview(tx, appId, session.user.id);
          return found.ok ? { ...found, draftHost: await requestDraftHost(tx, appId) } : found;
        });
        if (!admitted.ok)
          return reply
            .code(admitted.failure.code === 'forbidden' ? 403 : 404)
            .send({ failure: { name: 'AppFailure', code: admitted.failure.code, message: admitted.failure.message } });
        const started = admitted.draftHost.start;
        if (started)
          await start('appDraftHost', `app-draft-host-${appId}-${started.generation}`, {
            workspaceId,
            appId,
            generation: started.generation,
          }).catch(error => request.log.warn(errorAttributes(error), 'app_draft_host_start_failed'));
        await registerPreviewHost(storage.pool, { previewKey: admitted.previewKey, workspaceId, appId });
        const { ticket } = await issuePreviewTicket(storage.pool, {
          previewKey: admitted.previewKey,
          authSessionId: session.session.id,
          membershipId: admitted.membershipId,
        });
        return { ticket, entryUrl: `https://${previewHostOf(hosts, admitted.previewKey)}${previewEnterPath}` };
      } catch (error) {
        if (requestBoundaryError(error, reply)) return reply;
        throw error;
      }
    },
  );
}
