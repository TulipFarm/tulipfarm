import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { isFeatureEnabled } from '@tulipfarm/observability';
import type { SocialAccounts } from '@tulipfarm/social/accounts';
import type { SocialChannels } from '@tulipfarm/social/channels';
import {
  addChannelSchema,
  beginConnectionResultSchema,
  beginConnectionSchema,
  channelGrantsSchema,
  channelSchema,
  discoveredChannelSchema,
  disconnectResultSchema,
  platformAppCreateSchema,
  platformAppMetadataSchema,
  platformAvailabilitySchema,
  platformSchema,
  socialAccountGrantsSchema,
  socialAccountMetadataSchema,
} from '@tulipfarm/social/contracts';
import { SocialError } from '@tulipfarm/social/credentials';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const accountParams = workspaceParams.extend({ accountId: z.uuid() });
const appParams = workspaceParams.extend({ platformAppId: z.uuid() });
const channelParams = workspaceParams.extend({ channelId: z.uuid() });
const channelFilter = z.strictObject({ accountId: z.uuid().optional(), platform: platformSchema.optional() });
const callbackState = z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
const callbackSchema = z.union([
  z.strictObject({ code: z.string().min(1).max(4096), state: callbackState }),
  z.strictObject({
    error: z.string().min(1).max(256),
    state: callbackState,
    error_description: z.string().max(4096).optional(),
    error_uri: z.string().max(2048).optional(),
  }),
]);
const completionSchema = z.strictObject({ workspaceId: z.uuid(), account: socialAccountMetadataSchema });
const replaceSecretSchema = z.strictObject({ clientSecret: z.string().min(1).max(4096) });
const callbackPath = '/social/oauth/callback';

const validation = routeValidation({
  target: 'openapi-3.0',
  missing: 'Missing social request validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
function schema(operationId: string, summary: string, response: z.ZodType) {
  return {
    operationId,
    summary,
    tags: ['Social accounts'],
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
const statuses = {
  'platform-unavailable': 409,
  'workspace-app-required': 409,
  'platform-app-not-found': 404,
  'account-conflict': 409,
  'account-limit-reached': 409,
  'account-authorization-denied': 400,
  'account-reconnect-required': 409,
  'account-unavailable': 503,
  'grants-invalid': 400,
  'channel-conflict': 409,
  'channel-unreachable': 409,
  'channel-unavailable': 409,
} as const satisfies Record<SocialError['code'], number>;

/** The workspace a request concerns: from the path, or from the OAuth state on the callback. */
function requestWorkspace(request: FastifyRequest) {
  const params = z.object({ workspaceId: z.uuid() }).safeParse(request.params);
  if (params.success) return params.data.workspaceId;
  const query = z.object({ state: callbackState }).safeParse(request.query);
  return query.success ? query.data.state.slice(0, 36) : null;
}

/** Social connection routes. Every route, including the OAuth callback, sits behind `social-publishing`. */
export function registerSocialAccounts(
  app: FastifyInstance,
  auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>,
  accounts: SocialAccounts | null = null,
  enabled: (userId: string, workspaceId: string) => Promise<boolean> = (userId, workspaceId) =>
    isFeatureEnabled('social-publishing', { id: userId }, { id: workspaceId }),
  channels: SocialChannels | null = null,
) {
  app.register(async routes => {
    validation.install(routes, true);
    routes.addHook('onSend', async (request, reply, payload) => {
      if (!request.routeOptions.url?.endsWith(callbackPath) || !request.headers.accept?.includes('text/html'))
        return payload;
      const value: unknown = typeof payload === 'string' ? JSON.parse(payload) : null;
      const result = completionSchema.safeParse(value);
      const destination = new URL('/social/callback', authConfig().webOrigin);
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
        destination.searchParams.set('platform', result.data.account.platform);
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
      const workspaceId = requestWorkspace(request);
      if (!workspaceId) return reply.code(400).send({ error: 'invalid-request' });
      // A workspace without the flag sees no social routes at all.
      if (!(await enabled(session.user.id, workspaceId))) return reply.code(404).send({ error: 'not-found' });
      sessions.set(request, { userId: session.user.id, sessionId: session.session.id });
      if (!accounts) return reply.code(503).send({ error: 'account-unavailable' });
    });
    routes.setErrorHandler<FastifyError>((error, request, reply) => {
      if (error instanceof AccessDenied)
        return reply.code(404).send({
          error: request.routeOptions.url?.includes('/social/channels') ? 'channel-not-found' : 'account-not-found',
        });
      if (error.statusCode === 400 || error.validation || error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid-request' });
      if (error.statusCode === 413 || error.statusCode === 415)
        return reply.code(error.statusCode).send({ error: 'invalid-request' });
      if (error instanceof SocialError) return reply.code(statuses[error.code]).send({ error: error.code });
      return reply.code(503).send({ error: 'account-unavailable' });
    });
    const context = (request: FastifyRequest) => {
      const session = sessions.get(request);
      if (!session || !accounts) throw new SocialError('account-unavailable');
      return { ...session, accounts };
    };
    const channelContext = (request: FastifyRequest) => {
      const session = sessions.get(request);
      if (!session || !channels) throw new SocialError('account-unavailable');
      return { ...session, channels };
    };
    const social = '/workspaces/:workspaceId/social';
    routes.get(
      `${social}/availability`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'listSocialAvailabilityV1',
            'List every social platform and whether this workspace can connect it',
            z.array(platformAvailabilitySchema),
          ),
          params: json(workspaceParams),
        },
      },
      async request => {
        const { accounts, userId } = context(request);
        return accounts.availability(workspaceParams.parse(request.params).workspaceId, userId);
      },
    );
    routes.get(
      `${social}/platform-apps`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'listSocialPlatformAppsV1',
            'List the workspace’s own platform apps without their secrets',
            z.array(platformAppMetadataSchema),
          ),
          params: json(workspaceParams),
        },
      },
      async request => {
        const { accounts, userId } = context(request);
        return accounts.listApps(workspaceParams.parse(request.params).workspaceId, userId);
      },
    );
    routes.post(
      `${social}/platform-apps`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('createSocialPlatformAppV1', 'Register a workspace platform app', platformAppMetadataSchema),
          params: json(workspaceParams),
          body: json(platformAppCreateSchema),
        },
      },
      async request => {
        const { accounts, userId } = context(request);
        return accounts.createApp(workspaceParams.parse(request.params).workspaceId, userId, request.body);
      },
    );
    routes.post(
      `${social}/platform-apps/:platformAppId/replace-secret`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'replaceSocialPlatformAppSecretV1',
            'Replace a workspace platform app’s secret; its connections must reconnect',
            platformAppMetadataSchema,
          ),
          params: json(appParams),
          body: json(replaceSecretSchema),
        },
      },
      async request => {
        const { accounts, userId } = context(request);
        const { workspaceId, platformAppId } = appParams.parse(request.params);
        return accounts.replaceAppSecret(workspaceId, userId, platformAppId, request.body);
      },
    );
    const base = `${social}/accounts`;
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: {
          ...schema('listSocialAccountsV1', 'List social connections', z.array(socialAccountMetadataSchema)),
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
          ...schema(
            'beginSocialAccountV1',
            'Begin session-bound social account authorization',
            beginConnectionResultSchema,
          ),
          params: json(workspaceParams),
          body: json(beginConnectionSchema),
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
          ...schema('getSocialAccountV1', 'Read social connection status', socialAccountMetadataSchema),
          params: json(accountParams),
        },
      },
      async request => {
        const { accounts, userId } = context(request);
        const { workspaceId, accountId } = accountParams.parse(request.params);
        return accounts.status(workspaceId, userId, accountId);
      },
    );
    routes.post(
      `${base}/:accountId/reconnect`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('reconnectSocialAccountV1', 'Reconnect a social connection', beginConnectionResultSchema),
          params: json(accountParams),
        },
      },
      async request => {
        const { accounts, userId, sessionId } = context(request);
        const { workspaceId, accountId } = accountParams.parse(request.params);
        return accounts.reconnect(workspaceId, userId, sessionId, accountId);
      },
    );
    routes.post(
      `${base}/:accountId/disconnect`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('disconnectSocialAccountV1', 'Disconnect a social connection', disconnectResultSchema),
          params: json(accountParams),
        },
      },
      async request => {
        const { accounts, userId } = context(request);
        const { workspaceId, accountId } = accountParams.parse(request.params);
        return accounts.disconnect(workspaceId, userId, accountId);
      },
    );
    routes.get(
      `${base}/:accountId/grants`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'getSocialAccountGrantsV1',
            'Read who may use and who may manage a shared social connection',
            socialAccountGrantsSchema,
          ),
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
            'setSocialAccountGrantsV1',
            'Replace who may use and who may manage a shared social connection',
            socialAccountMetadataSchema,
          ),
          params: json(accountParams),
          body: json(socialAccountGrantsSchema),
        },
      },
      async request => {
        const { accounts, userId } = context(request);
        const { workspaceId, accountId } = accountParams.parse(request.params);
        return accounts.setGrants(workspaceId, userId, accountId, request.body);
      },
    );
    routes.get(
      `${base}/:accountId/channels`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'discoverSocialChannelsV1',
            'List the channels a connection can reach now; none is added',
            z.array(discoveredChannelSchema),
          ),
          params: json(accountParams),
        },
      },
      async request => {
        const { channels, userId } = channelContext(request);
        const { workspaceId, accountId } = accountParams.parse(request.params);
        return channels.discover(workspaceId, userId, accountId);
      },
    );
    const channelBase = `${social}/channels`;
    routes.get(
      channelBase,
      {
        logLevel: 'silent',
        schema: {
          ...schema('listSocialChannelsV1', 'List the channels the caller holds a grant on', z.array(channelSchema)),
          params: json(workspaceParams),
          querystring: json(channelFilter),
        },
      },
      async request => {
        const { channels, userId } = channelContext(request);
        return channels.list(
          workspaceParams.parse(request.params).workspaceId,
          userId,
          channelFilter.parse(request.query),
        );
      },
    );
    routes.post(
      channelBase,
      {
        logLevel: 'silent',
        schema: {
          ...schema('addSocialChannelV1', 'Add a reachable channel; the adder may only manage it', channelSchema),
          params: json(workspaceParams),
          body: json(addChannelSchema),
        },
      },
      async request => {
        const { channels, userId } = channelContext(request);
        return channels.add(workspaceParams.parse(request.params).workspaceId, userId, request.body);
      },
    );
    routes.get(
      `${channelBase}/:channelId`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('getSocialChannelV1', 'Read a social channel and its grants', channelSchema),
          params: json(channelParams),
        },
      },
      async request => {
        const { channels, userId } = channelContext(request);
        const { workspaceId, channelId } = channelParams.parse(request.params);
        return channels.get(workspaceId, userId, channelId);
      },
    );
    routes.put(
      `${channelBase}/:channelId/grants`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'setSocialChannelGrantsV1',
            'Replace who may publish, read analytics, engage and manage on a channel',
            channelSchema,
          ),
          params: json(channelParams),
          body: json(channelGrantsSchema),
        },
      },
      async request => {
        const { channels, userId } = channelContext(request);
        const { workspaceId, channelId } = channelParams.parse(request.params);
        return channels.setGrants(workspaceId, userId, channelId, request.body);
      },
    );
    routes.get(
      callbackPath,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'completeSocialAccountV1',
            'Complete one-time social account authorization for the initiating session; browser requests return to the web app',
            completionSchema,
          ),
          querystring: json(callbackSchema),
        },
      },
      async request => {
        const { accounts, userId, sessionId } = context(request);
        const callback = callbackSchema.parse(request.query);
        return accounts.complete('code' in callback ? callback.code : null, callback.state, sessionId, userId);
      },
    );
  });
}
