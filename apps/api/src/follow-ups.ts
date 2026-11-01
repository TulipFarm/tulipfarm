import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import type { createFollowUps } from '@tulipfarm/agents/follow-ups';
import { followUpViewSchema } from '@tulipfarm/agents/follow-up-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';

const params = z.strictObject({ workspaceId: z.uuid(), chatId: z.uuid(), followUpId: z.uuid() });
const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const validation = routeValidation({
  missing: 'Missing follow-up request validator',
  invalid: () => new Error('invalid-request'),
});
const schema = (operationId: string, summary: string) => ({
  operationId,
  summary,
  tags: ['Conversations'],
  params: validation.json(params),
  response: {
    200: validation.json(followUpViewSchema),
    400: errorSchema,
    401: errorSchema,
    403: errorSchema,
    404: errorSchema,
    500: errorSchema,
    503: errorSchema,
  },
});

/** The card a chat shows for a follow-up its requester scheduled, and its Cancel button. */
export function registerFollowUps(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    followUps: Pick<ReturnType<typeof createFollowUps>, 'readInChat' | 'cancelInChat'>;
  },
) {
  const { followUps } = dependencies;
  app.register(async routes => {
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: () => authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'follow-up-not-found' });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'follow-ups-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'follow-up-operation-failed' });
    });
    const path = '/workspaces/:workspaceId/conversations/:chatId/follow-ups/:followUpId';
    routes.get(
      path,
      { logLevel: 'silent', schema: schema('getConversationFollowUpV1', 'Read a follow-up you scheduled') },
      request => {
        const { workspaceId, chatId, followUpId } = params.parse(request.params);
        return followUps.readInChat(workspaceId, user(request), chatId, followUpId);
      },
    );
    routes.post(
      `${path}/cancel`,
      { schema: schema('cancelConversationFollowUpV1', 'Cancel a pending follow-up you scheduled') },
      request => {
        const { workspaceId, chatId, followUpId } = params.parse(request.params);
        return followUps.cancelInChat(workspaceId, user(request), chatId, followUpId);
      },
    );
  });
}
