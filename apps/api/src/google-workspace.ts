import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import type { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import {
  callbackSchema,
  GoogleCallbackError,
  GoogleWorkspaceError,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from '@tulipfarm/google-workspace/contracts';
import {
  googleAppSchema,
  googleAvailabilitySchema,
  googleAuthorizationSchema,
  googleCallbackResultSchema,
  googleDisconnectSchema,
  googleStatusSchema,
  type GoogleCallbackResult,
} from '@tulipfarm/google-workspace/public-contracts';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const paramsSchema = z.strictObject({ workspaceId: z.uuid() });
const beginQuerySchema = z.strictObject({ app: googleAppSchema.optional() });
const validation = routeValidation({
  missing: 'Missing Google Workspace request validator',
  invalid: () => new Error('invalid-request'),
});
const errorSchema = validation.json(z.strictObject({ error: z.string() }));
function schema(
  operationId: string,
  summary: string,
  response: z.ZodType,
  params?: z.ZodType,
  querystring?: z.ZodType,
) {
  return {
    operationId,
    summary,
    tags: ['Google Workspace'],
    ...(params ? { params: validation.json(params) } : {}),
    ...(querystring ? { querystring: validation.json(querystring) } : {}),
    response: {
      200: validation.json(response),
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
      409: errorSchema,
      413: errorSchema,
      415: errorSchema,
      429: errorSchema,
      500: errorSchema,
      502: errorSchema,
      503: errorSchema,
    },
  };
}

export function registerGoogleWorkspace(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: ReturnType<typeof createGoogleWorkspaceService>;
  },
) {
  const origin = authConfig().webOrigin;
  const isCallback = (request: FastifyRequest) =>
    request.routeOptions.schema?.operationId === 'completeGoogleWorkspaceOAuthV1';
  function redirect(reply: FastifyReply, input: GoogleCallbackResult) {
    const result = googleCallbackResultSchema.parse(input);
    const url = new URL('/google-workspace/callback', origin);
    url.searchParams.set('outcome', result.outcome);
    if (result.workspaceId) url.searchParams.set('workspaceId', result.workspaceId);
    return reply.redirect(url.href, 303);
  }
  app.register(async routes => {
    validation.install(routes);
    const principals = new WeakMap<FastifyRequest, SessionPrincipal>();
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session)
        return isCallback(request)
          ? redirect(reply, { outcome: 'sign-in-required' })
          : reply.code(401).send({ error: 'sign-in-required' });
      principals.set(request, sessionPrincipalSchema.parse({ userId: session.user.id, sessionId: session.session.id }));
    });
    const principal = (request: FastifyRequest) => sessionPrincipalSchema.parse(principals.get(request));
    routes.setErrorHandler((error, request, reply) => {
      if (isCallback(request)) {
        if (error instanceof GoogleCallbackError)
          return redirect(reply, { outcome: error.outcome, workspaceId: error.workspaceId });
        const outcome =
          error instanceof GoogleWorkspaceError
            ? error.code
            : error instanceof AccessDenied
              ? 'integration-not-found'
              : error instanceof StorageUnavailableError
                ? 'integrations-unavailable'
                : error instanceof z.ZodError ||
                    (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400)
                  ? 'invalid-request'
                  : 'integration-operation-failed';
        return redirect(reply, { outcome });
      }
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'integration-not-found' });
      if (error instanceof GoogleWorkspaceError) {
        const status = {
          'not-configured': 503,
          'invalid-state': 400,
          'consent-denied': 400,
          'reconnect-required': 409,
          'insufficient-scope': 409,
          'stale-integration': 409,
          'provider-unavailable': 502,
          'credential-unavailable': 503,
        }[error.code];
        return reply.code(status).send({ error: error.code });
      }
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'integrations-unavailable' });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'integration-operation-failed' });
    });
    const base = '/workspaces/:workspaceId/google-workspace';
    routes.get(
      '/google-workspace/availability',
      {
        logLevel: 'silent',
        schema: schema(
          'getGoogleWorkspaceAvailabilityV1',
          'Read Google authorization availability',
          googleAvailabilitySchema,
        ),
      },
      () => dependencies.service.availability(),
    );
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: schema(
          'getGoogleWorkspaceIntegrationV1',
          'Read your personal Google integration',
          googleStatusSchema,
          paramsSchema,
        ),
      },
      request => dependencies.service.status(paramsSchema.parse(request.params).workspaceId, principal(request).userId),
    );
    routes.post(
      `${base}/begin`,
      {
        logLevel: 'silent',
        schema: schema(
          'beginGoogleWorkspaceOAuthV1',
          'Begin personal Google authorization',
          googleAuthorizationSchema,
          paramsSchema,
          beginQuerySchema,
        ),
      },
      request =>
        dependencies.service.begin(
          paramsSchema.parse(request.params).workspaceId,
          principal(request),
          beginQuerySchema.parse(request.query).app,
        ),
    );
    routes.get(
      '/google-workspace/callback',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'completeGoogleWorkspaceOAuthV1',
          summary: 'Complete personal Google authorization',
          tags: ['Google Workspace'],
          querystring: validation.json(callbackSchema),
          response: { 303: { type: 'null', description: 'Return to the fixed web callback with a sanitized outcome' } },
        },
      },
      async (request, reply) => {
        const callback = callbackSchema.parse(request.query);
        await dependencies.service.complete(principal(request), callback);
        return redirect(reply, { outcome: 'connected', workspaceId: callback.state.split('.')[0] });
      },
    );
    routes.delete(
      base,
      {
        logLevel: 'silent',
        schema: schema(
          'disconnectGoogleWorkspaceV1',
          'Disconnect your personal Google account',
          googleDisconnectSchema,
          paramsSchema,
        ),
      },
      request =>
        dependencies.service.disconnect(paramsSchema.parse(request.params).workspaceId, principal(request).userId),
    );
  });
}
