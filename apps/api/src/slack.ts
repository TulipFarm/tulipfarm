import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { AccessDenied } from '@tulipfarm/access';
import { log } from '@tulipfarm/observability';
import { z } from 'zod';
import {
  eventEnvelopeSchema,
  slackLinkFailure,
  slackOAuthErrorCode,
  type createSlackInbox,
  type createSlackWelcome,
  type createSlackInstallations,
  type createSlackMemberLinking,
  type SlackConfiguration,
} from '@tulipfarm/slack';
import { attachmentInputSchema, type createSlackChannelAgents } from '@tulipfarm/agents/slack-channels';
import { SlackSignatureError, verifySlackRequest } from './slack-request.ts';
import { authConfig, type registerAuth } from './auth.ts';

export type SlackDependencies = {
  config: SlackConfiguration;
  installations: ReturnType<typeof createSlackInstallations>;
  inbox: ReturnType<typeof createSlackInbox>;
  welcome?: ReturnType<typeof createSlackWelcome>;
  memberLinking?: ReturnType<typeof createSlackMemberLinking>;
  channels?: ReturnType<typeof createSlackChannelAgents>;
};
const errorSchema = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
function schema(operationId: string, summary: string) {
  return {
    operationId,
    summary,
    tags: ['Slack'],
    response: {
      200: { type: 'object', additionalProperties: true },
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

export function registerSlack(
  app: FastifyInstance,
  auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>,
  dependencies: SlackDependencies | null = null,
) {
  app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'slack-not-found' });
      if (error.validation || error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-request' });
      if (error.message === 'slack-grants-conflict') return reply.code(409).send({ error: 'slack-grants-conflict' });
      if (error.statusCode === 413 || error.statusCode === 415)
        return reply.code(error.statusCode).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'slack-unavailable' });
    });
    const browserProof = (cookie: string | undefined) =>
      cookie
        ?.split(';')
        .map(value => value.trim())
        .find(value => value.startsWith('__Host-slack-link='))
        ?.slice('__Host-slack-link='.length) ?? '';
    for (const method of ['GET', 'PUT'] as const)
      routes.route({
        method,
        url: '/workspaces/:workspaceId/slack/grants',
        schema: schema(`slack${method}GrantsV1`, 'Read or replace explicit Slack installation grants'),
        handler: async (request, reply) => {
          if (method === 'PUT' && request.headers.origin !== authConfig().webOrigin)
            return reply.code(403).send({ error: 'untrusted-origin' });
          const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
          if (!session) return reply.code(401).send({ error: 'sign-in-required' });
          if (!dependencies) return reply.code(503).send({ error: 'slack-release-disabled' });
          return dependencies.installations.grants(
            z.object({ workspaceId: z.uuid() }).parse(request.params).workspaceId,
            session.user.id,
            method === 'PUT' ? request.body : undefined,
          );
        },
      });
    routes.get(
      '/workspaces/:workspaceId/slack/channels',
      {
        schema: {
          ...schema('listSlackBotChannelsV1', 'List Slack channels the TulipFarm bot belongs to'),
          params: {
            type: 'object',
            properties: { workspaceId: { type: 'string', format: 'uuid' } },
            required: ['workspaceId'],
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'sign-in-required' });
        if (!dependencies) return reply.code(503).send({ error: 'slack-release-disabled' });
        return dependencies.installations.channels(
          z.object({ workspaceId: z.uuid() }).parse(request.params).workspaceId,
          session.user.id,
        );
      },
    );
    for (const method of ['GET', 'PUT'] as const)
      routes.route({
        method,
        url: '/workspaces/:workspaceId/slack/channels/:channel',
        schema: {
          ...schema(
            method === 'GET' ? 'getSlackChannelAgentV1' : 'attachSlackChannelAgentV1',
            'Read or replace the attached channel agent',
          ),
          params: {
            type: 'object',
            properties: {
              workspaceId: { type: 'string', format: 'uuid' },
              channel: { type: 'string', pattern: '^[CG][A-Z0-9]+$' },
            },
            required: ['workspaceId', 'channel'],
            additionalProperties: false,
          },
          ...(method === 'PUT'
            ? { body: z.toJSONSchema(attachmentInputSchema.omit({ channel: true }), { target: 'draft-7' }) }
            : {}),
        },
        handler: async (request, reply) => {
          if (method === 'PUT' && request.headers.origin !== authConfig().webOrigin)
            return reply.code(403).send({ error: 'untrusted-origin' });
          const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
          if (!session) return reply.code(401).send({ error: 'sign-in-required' });
          if (!dependencies?.channels) return reply.code(503).send({ error: 'slack-channels-disabled' });
          const p = z.object({ workspaceId: z.uuid(), channel: z.string() }).parse(request.params);
          if (method === 'GET') return dependencies.channels.inspect(p.workspaceId, session.user.id, p.channel);
          return dependencies.channels.attach(p.workspaceId, session.user.id, {
            ...attachmentInputSchema.omit({ channel: true }).parse(request.body),
            channel: p.channel,
          });
        },
      });
    const callbackFields = {
      state: { type: 'string', minLength: 1, maxLength: 128 },
      code: { type: 'string', minLength: 1, maxLength: 4096 },
      error: { type: 'string', minLength: 1, maxLength: 256 },
    };
    const callbackInput = z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional() });
    async function recover(
      reply: FastifyReply,
      state: string,
      browser: string,
      session: { userId: string; sessionId: string } | null,
    ) {
      if (!dependencies?.memberLinking) return reply.code(503).send({ error: 'slack-linking-disabled' });
      const original = await dependencies.memberLinking.recover(state, browser, session);
      reply.header('Set-Cookie', '__Host-slack-link=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0');
      return reply.redirect(
        `${authConfig().webOrigin}/slack/link?workspaceId=${original.workspaceId}&eventId=${original.eventId}&recovery=retry`,
        303,
      );
    }
    routes.get(
      '/workspaces/:workspaceId/slack/link/:eventId',
      {
        schema: {
          ...schema('slackMemberLinkStatusV1', 'Read the current member held continuation'),
          params: {
            type: 'object',
            properties: {
              workspaceId: { type: 'string', format: 'uuid' },
              eventId: { type: 'string', format: 'uuid' },
            },
            required: ['workspaceId', 'eventId'],
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'sign-in-required' });
        if (!dependencies?.memberLinking || !dependencies.config.memberLinking)
          return reply.code(503).send({ error: 'slack-linking-disabled' });
        const params = z.object({ workspaceId: z.uuid(), eventId: z.uuid() }).parse(request.params);
        return dependencies.memberLinking.status(params.workspaceId, params.eventId, session.user.id);
      },
    );
    routes.post(
      '/workspaces/:workspaceId/slack/link',
      {
        schema: {
          ...schema('beginSlackMemberLinkV1', 'Link the sender of one held Slack event'),
          params: {
            type: 'object',
            properties: { workspaceId: { type: 'string', format: 'uuid' } },
            required: ['workspaceId'],
            additionalProperties: false,
          },
          body: {
            type: 'object',
            properties: { eventId: { type: 'string', format: 'uuid' } },
            required: ['eventId'],
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        if (request.headers.origin !== authConfig().webOrigin)
          return reply.code(403).send({ error: 'untrusted-origin' });
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'sign-in-required' });
        if (!dependencies?.memberLinking || !dependencies.config.memberLinking)
          return reply.code(503).send({ error: 'slack-linking-disabled' });
        const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
        const { eventId } = z.object({ eventId: z.uuid() }).parse(request.body);
        const result = await dependencies.memberLinking.begin(
          workspaceId,
          eventId,
          session.user.id,
          session.session.id,
        );
        reply.header(
          'Set-Cookie',
          `__Host-slack-link=${result.browser}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=600`,
        );
        return { url: result.url };
      },
    );
    routes.post(
      '/workspaces/:workspaceId/slack/unlink',
      {
        schema: {
          ...schema('unlinkSlackMemberV1', 'Revoke the current member Slack link'),
          params: {
            type: 'object',
            properties: { workspaceId: { type: 'string', format: 'uuid' } },
            required: ['workspaceId'],
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        if (request.headers.origin !== authConfig().webOrigin)
          return reply.code(403).send({ error: 'untrusted-origin' });
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'sign-in-required' });
        if (!dependencies?.memberLinking) return reply.code(503).send({ error: 'slack-linking-disabled' });
        return dependencies.memberLinking.unlink(
          z.object({ workspaceId: z.uuid() }).parse(request.params).workspaceId,
          session.user.id,
        );
      },
    );
    routes.register(async callbacks => {
      callbacks.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: 8192 },
        (_request, body, done) => {
          const form = new URLSearchParams(String(body));
          if ([...form.keys()].some(key => form.getAll(key).length !== 1))
            return done(new Error('duplicate-form-field'));
          done(null, Object.fromEntries(form));
        },
      );
      for (const method of ['GET', 'POST'] as const)
        callbacks.route({
          method,
          url: '/slack/link/identity',
          schema: {
            ...schema(
              method === 'GET' ? 'proveSlackMemberIdentityQueryV1' : 'proveSlackMemberIdentityV1',
              'Receive browser-bound Slack identity proof',
            ),
            [method === 'GET' ? 'querystring' : 'body']: {
              type: 'object',
              properties: callbackFields,
              required: ['state'],
              additionalProperties: false,
            },
          },
          handler: async (request, reply) => {
            if (method === 'POST' && request.headers.origin !== 'https://slack.com')
              return reply.code(403).send({ error: 'untrusted-origin' });
            if (!dependencies?.memberLinking) return reply.code(503).send({ error: 'slack-linking-disabled' });
            const { state, code, error } = callbackInput.parse(method === 'GET' ? request.query : request.body);
            const browser = browserProof(request.headers.cookie);
            if (error || !code) {
              log('warn', 'dependency', 'call_failed', {
                operation: 'slack.link.identity',
                'error.type': error ? slackOAuthErrorCode(error) : 'missing-code',
              });
              return recover(reply, state, browser, null);
            }
            try {
              await dependencies.memberLinking.proveIdentity(state, browser, code);
            } catch (failure) {
              log('warn', 'dependency', 'call_failed', {
                operation: 'slack.link.identity',
                ...slackLinkFailure(failure),
              });
              if (request.headers.accept?.includes('text/html')) return recover(reply, state, browser, null);
              throw failure;
            }
            return reply.redirect(`/v1/slack/link/consent?state=${encodeURIComponent(state)}`, 303);
          },
        });
    });
    for (const action of ['consent', 'complete'] as const)
      routes.get(
        `/slack/link/${action}`,
        {
          schema: {
            ...schema(`slackMember${action}V1`, `${action} session-bound Slack operational consent`),
            querystring: {
              type: 'object',
              properties: callbackFields,
              required: ['state'],
              additionalProperties: false,
            },
          },
        },
        async (request, reply) => {
          const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
          if (!dependencies?.memberLinking) return reply.code(503).send({ error: 'slack-linking-disabled' });
          const query = callbackInput.parse(request.query);
          const browser = browserProof(request.headers.cookie);
          const binding = session ? { userId: session.user.id, sessionId: session.session.id } : null;
          if (!session) {
            log('warn', 'dependency', 'call_failed', {
              operation: `slack.link.${action}`,
              'error.type': 'sign-in-required',
            });
            if (request.headers.accept?.includes('text/html')) return recover(reply, query.state, browser, null);
            return reply.code(401).send({ error: 'sign-in-required' });
          }
          if (query.error || (action === 'complete' && !query.code)) {
            log('warn', 'dependency', 'call_failed', {
              operation: `slack.link.${action}`,
              'error.type': query.error ? slackOAuthErrorCode(query.error) : 'missing-code',
            });
            return recover(reply, query.state, browser, binding);
          }
          try {
            if (action === 'consent')
              return reply.redirect(
                (await dependencies.memberLinking.consent(query.state, browser, session.user.id, session.session.id))
                  .url,
              );
            const result = await dependencies.memberLinking.complete(
              query.state,
              browser,
              z.string().parse(query.code),
              session.user.id,
              session.session.id,
            );
            reply.header('Set-Cookie', '__Host-slack-link=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0');
            if (request.headers.accept?.includes('text/html'))
              return reply.redirect(
                `${authConfig().webOrigin}/slack/link?workspaceId=${result.workspaceId}&eventId=${result.eventId}`,
              );
            return result;
          } catch (failure) {
            log('warn', 'dependency', 'call_failed', {
              operation: `slack.link.${action}`,
              ...slackLinkFailure(failure),
            });
            if (request.headers.accept?.includes('text/html')) return recover(reply, query.state, browser, binding);
            throw failure;
          }
        },
      );
    for (const action of ['status', 'install', 'disconnect'] as const) {
      routes.route({
        method: action === 'status' ? 'GET' : 'POST',
        url: `/workspaces/:workspaceId/slack/${action}`,
        schema: {
          ...schema(`slack${action}V1`, `${action} workspace Slack installation`),
          params: {
            type: 'object',
            properties: { workspaceId: { type: 'string', format: 'uuid' } },
            required: ['workspaceId'],
            additionalProperties: false,
          },
        },
        handler: async (request, reply) => {
          if (action !== 'status' && request.headers.origin !== authConfig().webOrigin)
            return reply.code(403).send({ error: 'untrusted-origin' });
          const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
          if (!session) return reply.code(401).send({ error: 'sign-in-required' });
          if (!dependencies) return reply.code(503).send({ error: 'slack-release-disabled' });
          const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
          if (action === 'status') return dependencies.installations.status(workspaceId, session.user.id);
          if (action === 'install')
            return dependencies.installations.begin(workspaceId, session.user.id, session.session.id);
          return dependencies.installations.disconnect(workspaceId, session.user.id);
        },
      });
    }
    routes.get(
      '/slack/oauth/callback',
      {
        schema: {
          ...schema('completeSlackOAuthV1', 'Complete a session-bound Slack installation'),
          querystring: {
            type: 'object',
            properties: {
              code: { type: 'string', minLength: 1, maxLength: 4096 },
              state: { type: 'string', minLength: 1, maxLength: 128 },
            },
            required: ['code', 'state'],
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'sign-in-required' });
        if (!dependencies) return reply.code(503).send({ error: 'slack-release-disabled' });
        const query = z.object({ code: z.string(), state: z.string() }).parse(request.query);
        try {
          const result = await dependencies.installations.complete(
            query.code,
            query.state,
            session.session.id,
            session.user.id,
          );
          if (request.headers.accept?.includes('text/html')) return reply.redirect(authConfig().webOrigin);
          return result;
        } catch {
          return reply.code(409).send({ error: 'slack-installation-unavailable' });
        }
      },
    );
    routes.register(async events => {
      events.removeContentTypeParser('application/json');
      events.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer', bodyLimit: 131072 },
        (_request, body, done) => done(null, body),
      );
      events.post(
        '/slack/events',
        {
          bodyLimit: 131072,
          schema: schema('receiveSlackEventV1', 'Persist a signed Slack event without executing it'),
        },
        async (request, reply) => {
          if (!dependencies) return reply.code(503).send({ error: 'slack-release-disabled' });
          try {
            if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'invalid-request' });
            verifySlackRequest({
              body: request.body,
              secret: dependencies.config.signingSecret,
              timestamp:
                typeof request.headers['x-slack-request-timestamp'] === 'string'
                  ? request.headers['x-slack-request-timestamp']
                  : undefined,
              signature:
                typeof request.headers['x-slack-signature'] === 'string'
                  ? request.headers['x-slack-signature']
                  : undefined,
            });
            const envelope = eventEnvelopeSchema.parse(JSON.parse(request.body.toString('utf8')));
            if (envelope.type === 'url_verification') return { challenge: envelope.challenge };
            if (envelope.api_app_id !== dependencies.config.appId)
              return reply.code(403).send({ error: 'slack-app-mismatch' });
            const route = await dependencies.installations.route(envelope.api_app_id, envelope.team_id);
            if (!route) return reply.code(404).send({ error: 'slack-installation-unavailable' });
            const accepted = await dependencies.inbox.accept(route, envelope);
            // Suggested prompts and the Home tab are best effort and must not delay Slack's acknowledgement.
            void dependencies.welcome?.handle(route, envelope);
            return accepted;
          } catch (error) {
            if (error instanceof SlackSignatureError) return reply.code(401).send({ error: 'slack-signature-invalid' });
            if (error instanceof z.ZodError || error instanceof SyntaxError)
              return reply.code(400).send({ error: 'invalid-request' });
            return reply.code(503).send({ error: 'slack-event-unavailable' });
          }
        },
      );
    });
  });
}
