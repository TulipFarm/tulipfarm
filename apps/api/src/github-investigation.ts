import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import type { createGitHubInvestigation } from '@tulipfarm/github/investigation';
import { investigationChoicesSchema, selectInvestigationSchema } from '@tulipfarm/github/investigation-contracts';
import { GitHubReadError } from '@tulipfarm/github/read-contracts';
import { GitHubAccountError } from '@tulipfarm/github';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';

export function registerGitHubInvestigation(
  app: FastifyInstance,
  auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>,
  investigation: ReturnType<typeof createGitHubInvestigation>,
) {
  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing investigation validator',
      invalid: () => new Error('invalid-request'),
    });
    const { json } = validation;
    validation.install(routes, true);
    const sessions = new WeakMap<FastifyRequest, string>();
    const params = z.strictObject({ workspaceId: z.uuid(), contextId: z.uuid() });
    const errorSchema = {
      type: 'object',
      properties: { error: { type: 'string' } },
      required: ['error'],
      additionalProperties: false,
    };
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET' && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      sessions.set(request, session.user.id);
    });
    routes.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'investigation-unavailable' });
      if (error instanceof GitHubReadError || error instanceof GitHubAccountError)
        return reply.code(409).send({ error: error.code });
      if (error.statusCode === 400 || error.validation || error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'investigation-unavailable' });
    });
    for (const kind of ['chats', 'tasks'] as const) {
      const path = `/workspaces/:workspaceId/github/${kind}/:contextId/investigation`;
      const schema = {
        tags: ['GitHub investigation'],
        params: json(params),
        response: {
          200: json(investigationChoicesSchema),
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      };
      routes.get(
        path,
        { logLevel: 'silent', schema: { ...schema, operationId: `getGitHubInvestigation${kind}V1` } },
        async request => {
          const { workspaceId, contextId } = params.parse(request.params);
          return investigation.choices(
            workspaceId,
            sessions.get(request)!,
            kind === 'chats' ? contextId : { taskId: contextId },
          );
        },
      );
      routes.put(
        path,
        {
          logLevel: 'silent',
          schema: {
            ...schema,
            operationId: `selectGitHubInvestigation${kind}V1`,
            body: json(selectInvestigationSchema),
          },
        },
        async request => {
          const { workspaceId, contextId } = params.parse(request.params);
          return investigation.select(
            workspaceId,
            sessions.get(request)!,
            kind === 'chats' ? contextId : { taskId: contextId },
            request.body,
          );
        },
      );
    }
  });
}
