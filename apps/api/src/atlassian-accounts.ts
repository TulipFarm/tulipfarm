import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import {
  AccountError,
  accountGrantsSchema,
  beginAccountSchema,
  accountCallbackSchema,
  accountUuidSchema,
  accountMetadataSchema,
  accountListSchema,
  accountAuthorizationSchema,
  accountCompletionSchema,
  accountDisconnectionSchema,
  type createAtlassianAccounts,
} from '@tulipfarm/atlassian/accounts';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const workspaceParams = z.strictObject({ workspaceId: accountUuidSchema });
const accountParams = workspaceParams.extend({ accountId: z.uuid() });
const validation = routeValidation({
  target: 'openapi-3.0',
  missing: 'Missing account request validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
function schema(operationId: string, summary: string, response: z.ZodType) {
  return {
    operationId,
    summary,
    tags: ['Atlassian accounts'],
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
export function registerAtlassianAccounts(
  app: FastifyInstance,
  auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>,
  accounts: ReturnType<typeof createAtlassianAccounts> | null = null,
) {
  app.register(async routes => {
    validation.install(routes, true);
    routes.addHook('onSend', async (request, reply, payload) => {
      if (
        !request.routeOptions.url?.endsWith('/atlassian/oauth/callback') ||
        !request.headers.accept?.includes('text/html')
      )
        return payload;
      const value: unknown = typeof payload === 'string' ? JSON.parse(payload) : null;
      const result = accountCompletionSchema.safeParse(value);
      const destination = new URL('/atlassian/callback', authConfig().webOrigin);
      destination.searchParams.set(
        'outcome',
        reply.statusCode === 200 && result.success
          ? 'connected'
          : reply.statusCode === 401
            ? 'sign-in-required'
            : typeof value === 'object' &&
                value !== null &&
                'error' in value &&
                value.error === 'account-authorization-denied'
              ? 'denied'
              : 'error',
      );
      if (reply.statusCode === 200 && result.success) {
        destination.searchParams.set('workspaceId', result.data.workspaceId);
        destination.searchParams.set('protocol', result.data.account.protocol);
      }
      reply.code(302).header('Location', destination.href).type('text/plain');
      return '';
    });
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
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'account-not-found' });
      if (error.statusCode === 400 || error.validation || error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid-request' });
      if (error.statusCode === 413 || error.statusCode === 415)
        return reply.code(error.statusCode).send({ error: 'invalid-request' });
      if (error instanceof AccountError) {
        const statuses = {
          'account-disabled': 503,
          'account-conflict': 409,
          'account-unavailable': 503,
          'account-reconnect-required': 409,
          'account-refresh-in-progress': 409,
          'account-authorization-denied': 400,
          'account-limit-reached': 409,
        };
        return reply.code(statuses[error.code]).send({ error: error.code });
      }
      return reply.code(503).send({ error: 'account-unavailable' });
    });
    const context = (request: FastifyRequest) => {
      const session = sessions.get(request);
      if (!session || !accounts) throw new AccountError('account-disabled');
      return { ...session, accounts };
    };
    const base = '/workspaces/:workspaceId/atlassian/accounts';
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'listAtlassianAccountsV1',
            'List authorized account metadata and provider availability',
            accountListSchema,
          ),
          params: json(workspaceParams),
        },
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
          ...schema('beginAtlassianAccountV1', 'Begin session-bound account authorization', accountAuthorizationSchema),
          params: json(workspaceParams),
          body: json(beginAccountSchema),
        },
      },
      async request => {
        const { accounts, userId, sessionId } = context(request);
        return accounts.begin(workspaceParams.parse(request.params).workspaceId, userId, sessionId, request.body);
      },
    );
    routes.get(
      `${base}/:accountId`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('getAtlassianAccountV1', 'Read account status', accountMetadataSchema),
          params: json(accountParams),
        },
      },
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
            ...schema(
              `${action}AtlassianAccountV1`,
              `${action} an authorized account`,
              action === 'reconnect' ? accountAuthorizationSchema : accountDisconnectionSchema,
            ),
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
    routes.get(
      `${base}/:accountId/grants`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('getAtlassianAccountGrantsV1', 'Read explicit business account use grants', accountGrantsSchema),
          params: json(accountParams),
        },
      },
      async request => {
        const { accounts, userId } = context(request);
        const { workspaceId, accountId } = accountParams.parse(request.params);
        return accounts.grants(workspaceId, userId, accountId);
      },
    );
    routes.put(
      `${base}/:accountId/grants`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'setAtlassianAccountGrantsV1',
            'Replace explicit business account use grants',
            accountMetadataSchema,
          ),
          params: json(accountParams),
          body: json(accountGrantsSchema),
        },
      },
      async request => {
        const { accounts, userId } = context(request);
        const { workspaceId, accountId } = accountParams.parse(request.params);
        return accounts.setGrants(workspaceId, userId, accountId, request.body);
      },
    );
    routes.get(
      '/atlassian/oauth/callback',
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'completeAtlassianAccountV1',
            'Complete one-time account authorization for the initiating session; browser requests return to Integrations',
            accountCompletionSchema,
          ),
          querystring: json(accountCallbackSchema),
        },
      },
      async request => {
        const { accounts, userId, sessionId } = context(request);
        const callback = accountCallbackSchema.parse(request.query);
        return accounts.complete('code' in callback ? callback.code : null, callback.state, sessionId, userId);
      },
    );
  });
}
