import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { isLoopbackRedirectUri } from '@tulipfarm/workspace-mcp-transport';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';
import { routeValidation } from './route-validation.ts';
import { requestSession } from './request-session.ts';

export type McpHttpAuth = { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> };
export class McpHttpError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 410 | 422 | 503;
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

export const mcpPastedSignInSchema = z.strictObject({ address: z.string().min(1).max(20000) });
const callbackKeys = ['state', 'code', 'iss', 'error', 'error_description', 'error_uri'] as const;
/**
 * Reads the address a provider redirected to when sign-in used a loopback redirect. It must be a loopback `http:`
 * address; its origin and path are returned so the attempt can check they match its own redirect.
 */
export function parsePastedSignIn(workspaceId: string, address: string) {
  const invalid = new McpHttpError('mcp-sign-in-address-invalid', 400);
  const text = address.trim();
  if (!URL.canParse(text)) throw invalid;
  const url = new URL(text);
  const landedAt = `${url.origin}${url.pathname}`;
  if (!isLoopbackRedirectUri(landedAt) || url.username || url.password) throw invalid;
  const query: Record<string, string> = {};
  for (const key of callbackKeys) {
    const values = url.searchParams.getAll(key);
    if (values.length > 1) throw invalid;
    if (values[0] !== undefined) query[key] = values[0];
  }
  const input = mcpCallbackSchema.safeParse(query);
  if (!input.success || !input.data.state.startsWith(`${workspaceId}_`)) throw invalid;
  return { input: input.data, landedAt };
}

export type McpCallbackOutcome =
  | { outcome: 'connected'; workspaceId: string; integrationId: string }
  | { outcome: 'sign-in-required' | 'denied' | 'expired' | 'failed' };
export function mcpCallbackRedirect(reply: FastifyReply, result: McpCallbackOutcome) {
  const url = new URL('/mcp/callback', authConfig().webOrigin);
  for (const [key, value] of Object.entries(result)) url.searchParams.set(key, value);
  return reply.redirect(url.href, 303);
}
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
  // The provider sends the browser here, so the callback answers with a page in the web app, never JSON.
  const isCallback = (request: FastifyRequest) =>
    request.routeOptions.schema?.operationId === 'completeWorkspaceMcpOAuthV1';
  routes.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== authConfig().webOrigin)
      return reply.code(403).send({ error: 'untrusted-origin' });
    const session = await requestSession(request, auth);
    if (!session)
      return isCallback(request)
        ? mcpCallbackRedirect(reply, { outcome: 'sign-in-required' })
        : reply.code(401).send({ error: 'sign-in-required' });
    sessions.set(request, { userId: session.user.id, sessionId: session.session.id });
  });
  routes.setErrorHandler((error, request, reply) => {
    if (isCallback(request)) {
      const code = error instanceof McpHttpError ? error.code : classify(error)?.code;
      return mcpCallbackRedirect(reply, {
        outcome:
          code === 'mcp-authorization-denied'
            ? 'denied'
            : code === 'mcp-expired' ||
                code === 'mcp-not-found' ||
                code === 'invalid-request' ||
                error instanceof AccessDenied
              ? 'expired'
              : 'failed',
      });
    }
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
          ...Object.fromEntries([400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 503].map(status => [status, error])),
        },
      };
    },
  };
}
