import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { BudConflict, type createBudAssistant } from '@tulipfarm/conversations/bud-assistant';
import { budCommandSchema, budStateSchema } from '@tulipfarm/conversations/bud-contracts';
import { PersonalMemoryConflict } from '@tulipfarm/conversations/personal-memory';
import { ConversationConflict } from '@tulipfarm/conversations';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const params = z.strictObject({ workspaceId: z.uuid() });
const validation = routeValidation({
  missing: 'Missing Bud request validator',
  invalid: () => new Error('invalid-request'),
});
const failure = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const schema = (operationId: string, body?: z.ZodType) => ({
  operationId,
  tags: ['Bud'],
  params: validation.json(params),
  ...(body ? { body: validation.json(body) } : {}),
  response: {
    200: validation.json(budStateSchema),
    400: failure,
    401: failure,
    403: failure,
    404: failure,
    409: failure,
    500: failure,
    503: failure,
  },
});
export function registerBud(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: ReturnType<typeof createBudAssistant>;
  },
) {
  app.register(async routes => {
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'bud-not-found' });
      if (error instanceof BudConflict || error instanceof PersonalMemoryConflict)
        return reply.code(409).send({ error: error.message });
      if (error instanceof ConversationConflict) return reply.code(409).send({ error: error.code });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'bud-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      app.log.error('Bud operation failed');
      return reply.code(500).send({ error: 'bud-operation-failed' });
    });
    routes.get('/workspaces/:workspaceId/bud', { logLevel: 'silent', schema: schema('getBudV1') }, request =>
      dependencies.service.read(params.parse(request.params).workspaceId, user(request)),
    );
    routes.post(
      '/workspaces/:workspaceId/bud',
      { logLevel: 'silent', schema: schema('commandBudV1', budCommandSchema) },
      request => dependencies.service.command(params.parse(request.params).workspaceId, user(request), request.body),
    );
  });
}
