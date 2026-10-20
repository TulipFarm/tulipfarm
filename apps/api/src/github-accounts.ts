import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { GitHubAccountError, type createGitHubAccounts } from '@tulipfarm/github';
import {
  accountSchema,
  accountListSchema,
  authorizationSchema,
  beginSchema,
  callbackSchema,
  completionSchema,
  disconnectionSchema,
  uuidSchema,
} from '@tulipfarm/github/contracts';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import type { createGitHubReads } from '@tulipfarm/github/reads';
import { GitHubReadError, selectAccountSchema, selectionSchema } from '@tulipfarm/github/read-contracts';

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const workspaceParams = z.strictObject({ workspaceId: uuidSchema });
const accountParams = workspaceParams.extend({ accountId: uuidSchema });
const validation = routeValidation({
  target: 'openapi-3.0',
  missing: 'Missing GitHub account validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
function schema(operationId: string, response: z.ZodType) {
  return {
    operationId,
    tags: ['GitHub personal accounts'],
    response: {
      200: json(response),
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
      409: errorSchema,
      413: errorSchema,
      415: errorSchema,
      503: errorSchema,
    },
  };
}
export function registerGitHubAccounts(
  app: FastifyInstance,
  auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>,
  accounts: ReturnType<typeof createGitHubAccounts> | null,
  reads?: ReturnType<typeof createGitHubReads>,
) {
  app.register(async routes => {
    validation.install(routes, true);
    const sessions = new WeakMap<FastifyRequest, { userId: string; sessionId: string }>();
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET' && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      sessions.set(request, { userId: session.user.id, sessionId: session.session.id });
      if (!accounts) return reply.code(503).send({ error: 'account-disabled' });
    });
    routes.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error instanceof GitHubReadError) return reply.code(409).send({ error: error.code });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'account-not-found' });
      if (error.statusCode === 400 || error.validation || error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid-request' });
      if (error.statusCode === 413 || error.statusCode === 415)
        return reply.code(error.statusCode).send({ error: 'invalid-request' });
      if (error instanceof GitHubAccountError) {
        const statuses = {
          'account-disabled': 503,
          'account-conflict': 409,
          'account-unavailable': 503,
          'account-reconnect-required': 409,
          'account-authorization-denied': 400,
          'account-limit-reached': 409,
        };
        return reply.code(statuses[error.code]).send({ error: error.code });
      }
      return reply.code(503).send({ error: 'account-unavailable' });
    });
    const context = (request: FastifyRequest) => {
      const session = sessions.get(request);
      if (!session || !accounts) throw new GitHubAccountError('account-disabled');
      return { ...session, accounts };
    };
    const base = '/workspaces/:workspaceId/github/accounts';
    const chatParams = workspaceParams.extend({ conversationId: uuidSchema });
    const selectionPath = '/workspaces/:workspaceId/github/chats/:conversationId/selection';
    const downloadParams = chatParams.extend({ downloadId: uuidSchema });
    routes.get(
      '/workspaces/:workspaceId/github/chats/:conversationId/downloads/:downloadId',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'downloadGitHubFileV1',
          tags: ['GitHub personal accounts'],
          params: json(downloadParams),
          response: {
            200: { type: 'string', format: 'binary' },
            401: errorSchema,
            404: errorSchema,
            409: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        if (!reads) throw new GitHubAccountError('account-disabled');
        const { userId } = context(request);
        const { workspaceId, conversationId, downloadId } = downloadParams.parse(request.params);
        const file = await reads.download(workspaceId, userId, conversationId, downloadId);
        return reply
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .header('Access-Control-Expose-Headers', 'Content-Disposition')
          .header('X-Content-Type-Options', 'nosniff')
          .type('application/octet-stream')
          .send(file.bytes);
      },
    );
    routes.get(
      selectionPath,
      {
        logLevel: 'silent',
        schema: { ...schema('getGitHubChatSelectionV1', selectionSchema), params: json(chatParams) },
      },
      async request => {
        if (!reads) throw new GitHubAccountError('account-disabled');
        const { userId } = context(request);
        const { workspaceId, conversationId } = chatParams.parse(request.params);
        return reads.selection(workspaceId, userId, conversationId);
      },
    );
    routes.put(
      selectionPath,
      {
        logLevel: 'silent',
        schema: {
          ...schema('selectGitHubChatAccountV1', selectionSchema),
          params: json(chatParams),
          body: json(selectAccountSchema),
        },
      },
      async request => {
        if (!reads) throw new GitHubAccountError('account-disabled');
        const { userId } = context(request);
        const { workspaceId, conversationId } = chatParams.parse(request.params);
        return reads.select(workspaceId, userId, conversationId, request.body);
      },
    );
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: { ...schema('listGitHubAccountsV1', accountListSchema), params: json(workspaceParams) },
      },
      async request => {
        const { accounts, userId } = context(request);
        return accounts.list(workspaceParams.parse(request.params).workspaceId, userId);
      },
    );
    routes.post(
      `${base}/begin`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('beginGitHubAccountV1', authorizationSchema),
          params: json(workspaceParams),
          body: json(beginSchema),
        },
      },
      async request => {
        const { accounts, userId, sessionId } = context(request);
        return accounts.begin(workspaceParams.parse(request.params).workspaceId, userId, sessionId);
      },
    );
    routes.get(
      `${base}/:accountId`,
      { logLevel: 'silent', schema: { ...schema('getGitHubAccountV1', accountSchema), params: json(accountParams) } },
      async request => {
        const { accounts, userId } = context(request);
        const { workspaceId, accountId } = accountParams.parse(request.params);
        return accounts.status(workspaceId, userId, accountId);
      },
    );
    for (const action of ['reconnect', 'disconnect'] as const)
      routes.post(
        `${base}/:accountId/${action}`,
        {
          logLevel: 'silent',
          schema: {
            ...schema(`${action}GitHubAccountV1`, action === 'reconnect' ? authorizationSchema : disconnectionSchema),
            params: json(accountParams),
          },
        },
        async request => {
          const { accounts, userId, sessionId } = context(request);
          const { workspaceId, accountId } = accountParams.parse(request.params);
          return action === 'reconnect'
            ? accounts.reconnect(workspaceId, userId, sessionId, accountId)
            : accounts.disconnect(workspaceId, userId, accountId);
        },
      );
    routes.post(
      '/github/oauth/callback',
      {
        logLevel: 'silent',
        bodyLimit: 16384,
        schema: { ...schema('completeGitHubAccountV1', completionSchema), body: json(callbackSchema) },
      },
      async request => {
        const { accounts, userId, sessionId } = context(request);
        return accounts.complete(request.body, sessionId, userId);
      },
    );
  });
}
