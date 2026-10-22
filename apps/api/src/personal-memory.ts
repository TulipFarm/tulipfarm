import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import {
  type createPersonalMemoryService,
  personalMemorySchema,
  savePersonalMemorySchema,
  deletePersonalMemorySchema,
  PersonalMemoryConflict,
} from '@tulipfarm/conversations/personal-memory';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const params = z.strictObject({ workspaceId: z.uuid() });
const validation = routeValidation({
  missing: 'Missing personal memory request validator',
  invalid: () => new Error('invalid-request'),
});
const failure = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
function schema(operationId: string, summary: string, body?: z.ZodType) {
  return {
    operationId,
    summary,
    tags: ['Personal memory'],
    params: validation.json(params),
    ...(body ? { body: validation.json(body) } : {}),
    response: {
      200: validation.json(personalMemorySchema),
      400: failure,
      401: failure,
      403: failure,
      404: failure,
      409: failure,
      413: failure,
      500: failure,
      503: failure,
    },
  };
}

export function registerPersonalMemory(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: ReturnType<typeof createPersonalMemoryService>;
  },
) {
  app.register(async routes => {
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'personal-memory-not-found' });
      if (error instanceof PersonalMemoryConflict) return reply.code(409).send({ error: error.message });
      if (error instanceof StorageUnavailableError)
        return reply.code(503).send({ error: 'personal-memory-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'personal-memory-operation-failed' });
    });
    const base = '/workspaces/:workspaceId/personal-memory';
    routes.get(base, { schema: schema('getPersonalMemoryV1', 'Read your personal memory') }, request =>
      dependencies.service.read(params.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      base,
      { schema: schema('savePersonalMemoryV1', 'Replace your personal memory', savePersonalMemorySchema) },
      request => dependencies.service.save(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.delete(
      base,
      { schema: schema('deletePersonalMemoryV1', 'Erase your personal memory', deletePersonalMemorySchema) },
      request => dependencies.service.delete(params.parse(request.params).workspaceId, user(request), request.body),
    );
  });
}
