import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { actorDirectorySchema, createActorDirectory } from '@tulipfarm/agents/actors';
import { commonCompatibility, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { requestBoundaryError } from './security.ts';
import { routeValidation } from './route-validation.ts';

/** The people and agents a row's actor fields can name. */
export function registerActors(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    runtime: Parameters<typeof createActorDirectory>[0];
  },
) {
  const service = createActorDirectory(dependencies.runtime);
  const params = z.object({ workspaceId: z.uuid() });
  const validation = routeValidation({
    missing: 'Missing actor validator',
    invalid: () => new Error('invalid-request'),
  });
  const errors = Object.fromEntries(
    [400, 401, 404, 503].map(status => [status, validation.json(z.object({ error: z.string() }))]),
  );
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'not-found' });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'workspace-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'actors-unavailable' });
    });
    routes.get(
      '/workspaces/:workspaceId/actors',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'workspaceActors',
          params: validation.json(params),
          response: { 200: validation.json(actorDirectorySchema), ...errors },
        },
      },
      request => {
        const { workspaceId } = params.parse(request.params);
        return service.read(workspaceId, user(request), commonCompatibility);
      },
    );
  });
}
