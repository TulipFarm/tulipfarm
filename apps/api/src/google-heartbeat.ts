import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { GoogleWorkspaceError } from '@tulipfarm/google-workspace/contracts';
import { GoogleLifecycleError } from '@tulipfarm/google-workspace/operations';
import {
  heartbeatCommandSchema,
  heartbeatPageSchema,
  heartbeatViewSchema,
  heartbeatResultsSchema,
  heartbeatRetrySchema,
  heartbeatRetryResultSchema,
  HeartbeatError,
} from '@tulipfarm/google-workspace/heartbeat-contracts';
import type { createGmailHeartbeat } from '@tulipfarm/google-workspace/heartbeat';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

export function registerGoogleHeartbeat(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: ReturnType<typeof createGmailHeartbeat>;
  },
) {
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing heartbeat validator',
      invalid: () => new Error('invalid-request'),
    });
    validation.install(routes);
    const users = new WeakMap<FastifyRequest, string>();
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      users.set(request, session.user.id);
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'heartbeat-not-found' });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-request' });
      if (
        error instanceof HeartbeatError ||
        error instanceof GoogleWorkspaceError ||
        error instanceof GoogleLifecycleError
      )
        return reply.code(409).send({ error: error.code });
      return reply.code(503).send({ error: 'heartbeat-unavailable' });
    });
    const params = z.strictObject({ workspaceId: z.uuid() });
    const user = (request: FastifyRequest) => z.string().parse(users.get(request));
    const errors = Object.fromEntries(
      [400, 401, 403, 404, 409, 413, 415, 429, 503].map(code => [
        code,
        validation.json(z.strictObject({ error: z.string() })),
      ]),
    );
    const schema = (operationId: string, response: z.ZodType) => ({
      operationId,
      tags: ['Google heartbeat'],
      params: validation.json(params),
      response: { 200: validation.json(response), ...errors },
    });
    const base = '/workspaces/:workspaceId/google-workspace/heartbeat';
    routes.get(base, { logLevel: 'silent', schema: schema('getGmailHeartbeatV1', heartbeatViewSchema) }, request =>
      dependencies.service.read(params.parse(request.params).workspaceId, user(request)),
    );
    routes.post(
      base,
      {
        logLevel: 'silent',
        bodyLimit: 65536,
        schema: {
          ...schema('configureGmailHeartbeatV1', heartbeatViewSchema),
          body: validation.json(heartbeatCommandSchema),
        },
      },
      request =>
        dependencies.service.configure(
          params.parse(request.params).workspaceId,
          user(request),
          heartbeatCommandSchema.parse(request.body),
        ),
    );
    routes.get(
      `${base}/results`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('listGmailHeartbeatResultsV1', heartbeatResultsSchema),
          querystring: validation.json(heartbeatPageSchema),
        },
      },
      request =>
        dependencies.service.results(
          params.parse(request.params).workspaceId,
          user(request),
          heartbeatPageSchema.parse(request.query),
        ),
    );
    routes.post(
      `${base}/retry`,
      {
        logLevel: 'silent',
        bodyLimit: 4096,
        schema: {
          ...schema('retryGmailHeartbeatV1', heartbeatRetryResultSchema),
          body: validation.json(heartbeatRetrySchema),
        },
      },
      request =>
        dependencies.service.retry(
          params.parse(request.params).workspaceId,
          user(request),
          heartbeatRetrySchema.parse(request.body),
        ),
    );
  });
}
