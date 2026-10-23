import { createHash } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { isFeatureEnabled } from '@tulipfarm/observability';
import type { SocialAccounts } from '@tulipfarm/social/accounts';
import type { SocialChannels } from '@tulipfarm/social/channels';
import { mediaUrlKey, mediaUrlPath } from '@tulipfarm/social/environment';
import { verifyMediaToken } from '@tulipfarm/social/media';
import type { SocialPosts } from '@tulipfarm/social/posts';
import type { SocialPublisher } from '@tulipfarm/social/publisher';
import {
  addChannelSchema,
  beginConnectionResultSchema,
  beginConnectionSchema,
  channelGrantsSchema,
  channelSchema,
  decisionSubmitSchema,
  discoveredChannelSchema,
  disconnectResultSchema,
  platformAppCreateSchema,
  platformAppMetadataSchema,
  platformAvailabilitySchema,
  platformSchema,
  postSchema,
  preparedPostSchema,
  prepareBodySchema,
  reconcileResultSchema,
  reviseBodySchema,
  scheduleQuerySchema,
  scheduleSchema,
  scheduleStates,
  settlementBodySchema,
  socialAccountGrantsSchema,
  socialAccountMetadataSchema,
  variantActionBodySchema,
  variantSchema,
  variantStateSchema,
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
const postParams = workspaceParams.extend({ postId: z.uuid() });
const variantParams = workspaceParams.extend({ variantId: z.uuid() });
/** `states` is a comma-separated list in the query string; omitted, the schedule shows every listed state. */
const scheduleQuery = z
  .strictObject({ channelId: z.uuid().optional(), states: z.string().max(256).optional() })
  .transform(query =>
    scheduleQuerySchema.parse({
      ...(query.channelId ? { channelId: query.channelId } : {}),
      ...(query.states ? { states: query.states.split(',').map(state => variantStateSchema.parse(state)) } : {}),
    }),
  );
/** A wildcard, since a token is longer than a route parameter may be. */
const mediaParams = z.strictObject({ '*': z.string().regex(/^[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/) });
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

/** Reads one stored object, at most `maximumBytes`; the files object store. */
export type SocialMediaBytes = (key: string, maximumBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;

/** One satisfiable `bytes=` range, or null for the whole object; `false` when the range cannot be served. */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | false {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : false;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start < size && start <= end ? { start, end } : false;
}

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
  'post-conflict': 409,
  'revision-conflict': 409,
  'revision-expired': 409,
  'variant-invalid': 409,
  'variant-not-editable': 409,
  'review-choices-invalid': 400,
  'source-blocked': 409,
  'source-unreadable': 403,
  'media-unreadable': 403,
  'media-changed': 409,
  'variant-conflict': 409,
  'settlement-unconfirmed': 409,
} as const satisfies Record<SocialError['code'], number>;

/** The workspace a request concerns: from the path, or from the OAuth state on the callback. */
function requestWorkspace(request: FastifyRequest) {
  const params = z.object({ workspaceId: z.uuid() }).safeParse(request.params);
  if (params.success) return params.data.workspaceId;
  const query = z.object({ state: callbackState }).safeParse(request.query);
  return query.success ? query.data.state.slice(0, 36) : null;
}

/** What the web callback page tells the person after an OAuth callback fails for a known reason. */
const callbackOutcomes: Partial<Record<string, 'denied' | 'reconnect-required' | 'expired'>> = {
  'account-authorization-denied': 'denied',
  'account-reconnect-required': 'reconnect-required',
  'account-conflict': 'expired',
};

/** Social connection routes. Every route, including the OAuth callback, sits behind `social-publishing`. */
export function registerSocialAccounts(
  app: FastifyInstance,
  auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>,
  accounts: SocialAccounts | null = null,
  enabled: (userId: string, workspaceId: string) => Promise<boolean> = (userId, workspaceId) =>
    isFeatureEnabled('social-publishing', { id: userId }, { id: workspaceId }),
  channels: SocialChannels | null = null,
  posts: SocialPosts | null = null,
  publisher: SocialPublisher | null = null,
  mediaBytes: SocialMediaBytes | null = null,
  env: NodeJS.ProcessEnv = process.env,
) {
  registerSocialMedia(app, enabled, publisher, mediaBytes, env);
  app.register(async routes => {
    validation.install(routes, true);
    routes.addHook('onSend', async (request, reply, payload) => {
      if (!request.routeOptions.url?.endsWith(callbackPath) || !request.headers.accept?.includes('text/html'))
        return payload;
      const value: unknown = typeof payload === 'string' ? JSON.parse(payload) : null;
      const result = completionSchema.safeParse(value);
      const failure = z.object({ error: z.string() }).safeParse(value);
      const destination = new URL('/social/callback', authConfig().webOrigin);
      const failed = failure.success ? callbackOutcomes[failure.data.error] : undefined;
      destination.searchParams.set(
        'outcome',
        reply.statusCode === 200 && result.success
          ? 'connected'
          : reply.statusCode === 401
            ? 'sign-in-required'
            : (failed ?? 'error'),
      );
      if (reply.statusCode === 200 && result.success) {
        destination.searchParams.set('workspaceId', result.data.workspaceId);
        destination.searchParams.set('platform', result.data.account.platform);
      } else if (failed) {
        // The workspace comes from the person's own OAuth state; a missing or hidden attempt names none.
        const workspaceId = requestWorkspace(request);
        if (workspaceId) destination.searchParams.set('workspaceId', workspaceId);
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
          error: request.routeOptions.url?.includes('/social/channels')
            ? 'channel-not-found'
            : request.routeOptions.url?.includes('/social/posts')
              ? 'post-not-found'
              : request.routeOptions.url?.includes('/social/variants')
                ? 'variant-not-found'
                : 'account-not-found',
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
    const postContext = (request: FastifyRequest) => {
      const session = sessions.get(request);
      if (!session || !posts) throw new SocialError('account-unavailable');
      return { ...session, posts };
    };
    const publisherContext = (request: FastifyRequest) => {
      const session = sessions.get(request);
      if (!session || !publisher) throw new SocialError('account-unavailable');
      return { ...session, publisher };
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
    const postBase = `${social}/posts`;
    routes.post(
      postBase,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'prepareSocialPostV1',
            'Prepare a post from a chat, one variant per channel, checked against each channel’s rules',
            preparedPostSchema,
          ),
          params: json(workspaceParams),
          body: json(prepareBodySchema),
        },
      },
      async (request, reply) => {
        const { posts, userId } = postContext(request);
        const body = prepareBodySchema.parse(request.body);
        // Only a chat origin reaches this route; its conversation is the post's source.
        if (body.origin.kind !== 'conversation') return reply.code(400).send({ error: 'invalid-request' });
        return posts.prepare(workspaceParams.parse(request.params).workspaceId, userId, body, {
          dependencies: [{ kind: 'private-conversation', conversationId: body.origin.conversationId }],
        });
      },
    );
    routes.get(
      `${postBase}/:postId`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('getSocialPostV1', 'Read a post with its revisions, decisions and variants', postSchema),
          params: json(postParams),
        },
      },
      async request => {
        const { posts, userId } = postContext(request);
        const { workspaceId, postId } = postParams.parse(request.params);
        return posts.get(workspaceId, userId, postId);
      },
    );
    routes.post(
      `${postBase}/:postId/revisions`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'reviseSocialPostV1',
            'Edit the unattempted variants as a new revision that needs its own approval',
            preparedPostSchema,
          ),
          params: json(postParams),
          body: json(reviseBodySchema),
        },
      },
      async request => {
        const { posts, userId } = postContext(request);
        const { workspaceId, postId } = postParams.parse(request.params);
        return posts.revise(workspaceId, userId, postId, request.body);
      },
    );
    routes.post(
      `${postBase}/:postId/decision`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'decideSocialPostV1',
            'Approve or reject the current revision, bound to its content digest and review choices',
            postSchema,
          ),
          params: json(postParams),
          body: json(decisionSubmitSchema),
        },
      },
      async (request, reply) => {
        const { posts, userId } = postContext(request);
        const { workspaceId, postId } = postParams.parse(request.params);
        const body = decisionSubmitSchema.parse(request.body);
        if (body.postId !== postId) return reply.code(400).send({ error: 'invalid-request' });
        return posts.decide(workspaceId, userId, body);
      },
    );
    routes.get(
      `${social}/schedule`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'listSocialScheduleV1',
            `List variants by channel and state (${scheduleStates.join(', ')}) on channels the caller may publish to`,
            scheduleSchema,
          ),
          params: json(workspaceParams),
          querystring: json(scheduleQuery),
        },
      },
      async request => {
        const { posts, userId } = postContext(request);
        return posts.schedule(
          workspaceParams.parse(request.params).workspaceId,
          userId,
          // Validation already parsed the query string into the schedule query.
          scheduleQuerySchema.parse(request.query),
        );
      },
    );
    const variantBase = `${social}/variants/:variantId`;
    routes.post(
      `${variantBase}/resume`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'resumeSocialVariantV1',
            'Rerun every check for a blocked variant; it is due again only if they pass',
            variantSchema,
          ),
          params: json(variantParams),
          body: json(variantActionBodySchema),
        },
      },
      async request => {
        const { publisher, userId } = publisherContext(request);
        const { workspaceId, variantId } = variantParams.parse(request.params);
        return publisher.resume(workspaceId, userId, { ...variantActionBodySchema.parse(request.body), variantId });
      },
    );
    routes.post(
      `${variantBase}/cancel`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('cancelSocialVariantV1', 'Cancel a blocked variant; it is not published', variantSchema),
          params: json(variantParams),
          body: json(variantActionBodySchema),
        },
      },
      async request => {
        const { publisher, userId } = publisherContext(request);
        const { workspaceId, variantId } = variantParams.parse(request.params);
        return publisher.cancel(workspaceId, userId, { ...variantActionBodySchema.parse(request.body), variantId });
      },
    );
    routes.get(
      `${variantBase}/candidates`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'listSocialVariantCandidatesV1',
            'Ask the platform what became of a variant whose outcome is unknown',
            reconcileResultSchema,
          ),
          params: json(variantParams),
        },
      },
      async request => {
        const { publisher, userId } = publisherContext(request);
        const { workspaceId, variantId } = variantParams.parse(request.params);
        return publisher.candidates(workspaceId, userId, variantId);
      },
    );
    routes.post(
      `${variantBase}/settlement`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'settleSocialVariantV1',
            'Settle an unknown outcome: confirm the platform post it became, or that it was not published',
            variantSchema,
          ),
          params: json(variantParams),
          body: json(settlementBodySchema),
        },
      },
      async request => {
        const { publisher, userId } = publisherContext(request);
        const { workspaceId, variantId } = variantParams.parse(request.params);
        return publisher.settle(workspaceId, userId, { ...settlementBodySchema.parse(request.body), variantId });
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

/**
 * `GET /v1/social/media/:token`: the bytes of the one File a signed media URL names, for the platform to pull while
 * the attempt's step runs (TECH, Media). There is no session; the token is the only authority, and it widens
 * nothing: the publisher rechecks the attempt, step, binding and the sponsor's read access on every request. Every
 * refusal is the same 404, so a token reveals nothing about why it failed.
 */
function registerSocialMedia(
  app: FastifyInstance,
  enabled: (userId: string, workspaceId: string) => Promise<boolean>,
  publisher: SocialPublisher | null,
  mediaBytes: SocialMediaBytes | null,
  env: NodeJS.ProcessEnv,
) {
  app.register(async routes => {
    const media = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing social media validator',
      invalid: () => new Error('invalid-request'),
    });
    media.install(routes);
    const notFound = { error: 'not-found' };
    routes.setErrorHandler((_error, _request, reply) =>
      reply.code(404).header('Cache-Control', 'no-store').send(notFound),
    );
    routes.get(
      `${mediaUrlPath.replace(/^\/v1/, '')}*`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'readSocialMediaV1',
          summary: 'Serve the File a signed social media URL names, while its publish step runs',
          tags: ['Social accounts'],
          params: media.json(mediaParams),
          response: {
            200: { type: 'string', format: 'binary' },
            206: { type: 'string', format: 'binary' },
            404: errorSchema,
            416: errorSchema,
          },
        },
      },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        const key = mediaUrlKey(env);
        if (!key || !publisher || !mediaBytes) return reply.code(404).send(notFound);
        const grant = verifyMediaToken(key, mediaParams.parse(request.params)['*']);
        if (!grant || !(await enabled('social-publisher', grant.workspaceId))) return reply.code(404).send(notFound);
        const file = await publisher.mediaObject(grant);
        if (!file) return reply.code(404).send(notFound);
        const reader = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) reader.abort();
        });
        const bytes = await mediaBytes(file.path, file.size, reader.signal);
        // The object must be the bytes the File records, which are the bytes the person approved.
        if (bytes.byteLength !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
          return reply.code(404).send(notFound);
        const range = byteRange(
          typeof request.headers.range === 'string' ? request.headers.range : undefined,
          file.size,
        );
        reply.header('Accept-Ranges', 'bytes');
        if (range === false)
          return reply.code(416).header('Content-Range', `bytes */${file.size}`).send({ error: 'invalid-range' });
        reply
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Disposition', 'attachment')
          .type(file.mediaType);
        if (!range) return reply.send(Buffer.from(bytes));
        return reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
          .send(Buffer.from(bytes.subarray(range.start, range.end + 1)));
      },
    );
  });
}
