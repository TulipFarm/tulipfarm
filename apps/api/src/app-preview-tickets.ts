import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppId } from '@tulipfarm/apps';
import { admitPreview, issuePreviewTicket, registerPreviewHost } from '@tulipfarm/apps/store';
import { previewEnterPath } from '@tulipfarm/gateway/preview';
import type { PreviewStorage } from '@tulipfarm/gateway/preview-environment';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';

const enabled = (workspaceId: string) => isFeatureEnabled('app-hosting', null, { id: workspaceId });

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
        const admitted = await storage.runtime.transaction(workspaceId, commonCompatibility, tx =>
          admitPreview(tx, appId, session.user.id),
        );
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
