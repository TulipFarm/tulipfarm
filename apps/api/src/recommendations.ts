import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { StorageUnavailableError, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { registerAuth } from './auth.ts';
import { recommendationListSchema, readSavedRecommendations } from '@tulipfarm/recommendations';

export function registerRecommendations(
  app: FastifyInstance,
  dependencies: {
    runtime: WorkspaceRuntime;
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
  },
) {
  const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
  app.get(
    '/workspaces/:workspaceId/recommendations',
    {
      logLevel: 'silent',
      schema: {
        operationId: 'getChatRecommendationsV1',
        summary: 'Read saved private Bud recommendations for the caller',
        tags: ['Conversations'],
        params: {
          type: 'object',
          properties: { workspaceId: { type: 'string', format: 'uuid' } },
          required: ['workspaceId'],
        },
        response: {
          200: z.toJSONSchema(recommendationListSchema),
          400: error,
          401: error,
          404: error,
          500: error,
          503: error,
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const params = z.object({ workspaceId: z.uuid() }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid-request' });
      try {
        return await dependencies.runtime.transaction(params.data.workspaceId, commonCompatibility, async tx => {
          await lockAuthorization(tx);
          const actor = await resolveHuman(tx, session.user.id);
          return readSavedRecommendations(tx, actor.membershipId);
        });
      } catch (cause) {
        if (cause instanceof AccessDenied) return reply.code(404).send({ error: 'workspace-not-found' });
        if (cause instanceof StorageUnavailableError)
          return reply.code(503).send({ error: 'recommendations-unavailable' });
        app.log.error({ workspaceId: params.data.workspaceId }, 'Saved recommendations could not be read');
        return reply.code(500).send({ error: 'recommendations-read-failed' });
      }
    },
  );
}
