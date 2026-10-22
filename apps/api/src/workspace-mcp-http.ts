import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';
import { routeValidation } from './route-validation.ts';

export type McpHttpAuth = { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> };
export class McpHttpError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 410 | 503;
  constructor(code: string, status: McpHttpError['status']) {
    super(code);
    this.code = code;
    this.status = status;
    this.name = 'McpHttpError';
  }
}

export const mcpHttpId = z.uuid().transform(value => value.toLowerCase());
export const mcpWorkspaceParams = z.strictObject({ workspaceId: mcpHttpId });
export const mcpIntegrationParams = mcpWorkspaceParams.extend({ integrationId: mcpHttpId });
export const mcpActionParams = mcpWorkspaceParams.extend({ actionId: mcpHttpId });
export const mcpCallbackSchema = z.union([
  z.strictObject({
    state: z.string().min(32).max(2048),
    code: z.string().min(1).max(16384),
    iss: z.url().max(2048).optional(),
  }),
  z.strictObject({
    state: z.string().min(32).max(2048),
    error: z.string().min(1).max(256),
    error_description: z.string().max(2048).optional(),
    error_uri: z.string().max(2048).optional(),
    iss: z.url().max(2048).optional(),
  }),
]);

export function workspaceMcpHttp(
  routes: FastifyInstance,
  auth: McpHttpAuth,
  classify: (error: unknown) => McpHttpError | null,
) {
  const validation = routeValidation({
    target: 'openapi-3.0',
    missing: 'Missing workspace MCP validator',
    invalid: () => new McpHttpError('invalid-request', 400),
  });
  validation.install(routes, true);
  const sessions = new WeakMap<FastifyRequest, { userId: string; sessionId: string }>();
  routes.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== authConfig().webOrigin)
      return reply.code(403).send({ error: 'untrusted-origin' });
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return reply.code(401).send({ error: 'sign-in-required' });
    sessions.set(request, { userId: session.user.id, sessionId: session.session.id });
  });
  routes.setErrorHandler((error, request, reply) => {
    if (requestBoundaryError(error, reply)) return;
    if (error instanceof AccessDenied) return reply.code(404).send({ error: 'mcp-not-found' });
    if (error instanceof z.ZodError)
      return reply
        .code(request.validationError ? 400 : 503)
        .send({ error: request.validationError ? 'invalid-request' : 'mcp-unavailable' });
    if (typeof error === 'object' && error !== null && 'validation' in error)
      return reply.code(400).send({ error: 'invalid-request' });
    const known = error instanceof McpHttpError ? error : classify(error);
    if (known) return reply.code(known.status).send({ error: known.code });
    return reply.code(503).send({ error: 'mcp-unavailable' });
  });
  const error = {
    type: 'object',
    properties: { error: { type: 'string' } },
    required: ['error'],
    additionalProperties: false,
  };
  return {
    json: validation.json,
    session(request: FastifyRequest) {
      const session = sessions.get(request);
      if (!session) throw new McpHttpError('sign-in-required', 503);
      return session;
    },
    schema(operationId: string, output: z.ZodType, params?: z.ZodType, body?: z.ZodType, querystring?: z.ZodType) {
      return {
        operationId,
        tags: ['Workspace MCP'],
        ...(params ? { params: validation.json(params) } : {}),
        ...(body ? { body: validation.json(body) } : {}),
        ...(querystring ? { querystring: validation.json(querystring) } : {}),
        response: {
          200: validation.json(output),
          ...Object.fromEntries([400, 401, 403, 404, 409, 410, 413, 415, 429, 503].map(status => [status, error])),
        },
      };
    },
  };
}
