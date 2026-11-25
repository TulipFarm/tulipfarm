import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import {
  BrowserHostError,
  browserSessionId,
  browserSessionStateSchema,
  siteIncludes,
  type BrowserHostClient,
} from '@tulipfarm/browser';
import {
  BrowserLoginError,
  browserLoginSummarySchema,
  saveBrowserLoginSchema,
  shareBrowserLoginSchema,
  type BrowserLogins,
} from '@tulipfarm/browser/logins';
import { errorAttributes } from '@tulipfarm/observability';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import type { registerAuth } from './auth.ts';
import { authConfig } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const loginParams = z.strictObject({ workspaceId: z.uuid(), loginId: z.uuid() });
const chatParams = z.strictObject({ workspaceId: z.uuid(), chatId: z.uuid() });
const chatLoginParams = z.strictObject({ workspaceId: z.uuid(), chatId: z.uuid(), loginId: z.uuid() });
const listQuery = z.strictObject({ site: z.string().max(253).optional() });
const renameBody = z.strictObject({ name: z.string() });
const listResponse = z.strictObject({ enabled: z.boolean(), logins: z.array(browserLoginSummarySchema) });
const stateResponse = z.strictObject({ browser: browserSessionStateSchema });
const okResponse = z.strictObject({ ok: z.literal(true) });
const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const validation = routeValidation({
  missing: 'Missing browser login request validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
function schema(
  operationId: string,
  summary: string,
  tag: string,
  params: z.ZodType,
  response: z.ZodType,
  extra: { body?: z.ZodType; querystring?: z.ZodType } = {},
) {
  return {
    operationId,
    summary,
    tags: [tag],
    params: json(params),
    ...(extra.body ? { body: json(extra.body) } : {}),
    ...(extra.querystring ? { querystring: json(extra.querystring) } : {}),
    response: Object.fromEntries([
      [200, json(response)],
      ...[400, 401, 403, 404, 409, 413, 503].map(status => [status, errorSchema]),
    ]),
  };
}

/**
 * Browser logins: a member saves a chat browser's signed-in state for a site, loads saved logins they may use into
 * a chat's browser, and renames, shares and deletes them. Nobody can read a saved state back.
 */
export function registerBrowserLogins(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    chats: { read(workspaceId: string, userId: string, chatId: string): Promise<{ projectId: string | null }> };
    client: BrowserHostClient | undefined;
    logins: BrowserLogins;
  },
) {
  const { chats, client, logins } = dependencies;
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: () => authConfig().webOrigin });
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.setErrorHandler((error, request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'browser-login-not-found' });
      if (error instanceof StorageUnavailableError)
        return reply.code(503).send({ error: 'browser-logins-unavailable' });
      if (error instanceof BrowserLoginError) {
        if (error.code === 'invalid-input') return reply.code(400).send({ error: 'invalid-request' });
        if (error.code === 'too-large') return reply.code(413).send({ error: 'browser-login-too-large' });
        if (error.code === 'unavailable') return reply.code(409).send({ error: 'browser-login-unavailable' });
        if (error.code === 'project-chat') return reply.code(409).send({ error: 'browser-login-project-chat' });
        return reply.code(503).send({ error: 'browser-logins-unavailable' });
      }
      if (error instanceof BrowserHostError) {
        if (error.code === 'session-not-found') return reply.code(404).send({ error: 'browser-not-found' });
        if (error.code === 'invalid-request') return reply.code(400).send({ error: 'invalid-request' });
        request.log.warn(errorAttributes(error), 'browser_host_failed');
        return reply.code(503).send({ error: 'browser-unavailable' });
      }
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      request.log.error(errorAttributes(error), 'browser_logins_failed');
      return reply.code(503).send({ error: 'browser-logins-unavailable' });
    });

    /**
     * Authorizes the chat's owner and returns its browser session. Project members can watch a project chat's browser,
     * so logins are saved and loaded only in a member's own chats outside projects.
     */
    async function session(request: FastifyRequest, params: { workspaceId: string; chatId: string }) {
      const chat = await chats.read(params.workspaceId, user(request), params.chatId);
      if (chat.projectId) throw new BrowserLoginError('project-chat');
      if (!client) throw new BrowserHostError('unavailable', 'Browser use is not configured');
      return { client, sessionId: browserSessionId(params.workspaceId, { conversationId: params.chatId }) };
    }

    const base = '/workspaces/:workspaceId/browser-logins';
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: schema(
          'listBrowserLoginsV1',
          'List the browser logins the member can use or manage, optionally for one site',
          'Browser logins',
          workspaceParams,
          listResponse,
          { querystring: listQuery },
        ),
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const { site } = listQuery.parse(request.query);
        if (!logins.capabilities().enabled) return { enabled: false, logins: [] };
        return { enabled: true, logins: await logins.list(workspaceId, user(request), site ? { site } : {}) };
      },
    );

    routes.patch(
      `${base}/:loginId`,
      {
        schema: schema(
          'renameBrowserLoginV1',
          'Rename a browser login',
          'Browser logins',
          loginParams,
          browserLoginSummarySchema,
          { body: renameBody },
        ),
      },
      async request => {
        const { workspaceId, loginId } = loginParams.parse(request.params);
        return logins.rename(workspaceId, user(request), loginId, renameBody.parse(request.body).name);
      },
    );

    routes.put(
      `${base}/:loginId/grants`,
      {
        schema: schema(
          'shareBrowserLoginV1',
          'Replace whom a browser login is shared with',
          'Browser logins',
          loginParams,
          browserLoginSummarySchema,
          { body: shareBrowserLoginSchema },
        ),
      },
      async request => {
        const { workspaceId, loginId } = loginParams.parse(request.params);
        return logins.share(workspaceId, user(request), loginId, request.body);
      },
    );

    routes.delete(
      `${base}/:loginId`,
      {
        schema: schema('deleteBrowserLoginV1', 'Delete a browser login', 'Browser logins', loginParams, okResponse),
      },
      async request => {
        const { workspaceId, loginId } = loginParams.parse(request.params);
        await logins.remove(workspaceId, user(request), loginId);
        return { ok: true as const };
      },
    );

    const chatBase = '/workspaces/:workspaceId/conversations/:chatId/browser/logins';
    routes.post(
      chatBase,
      {
        logLevel: 'silent',
        schema: schema(
          'saveConversationBrowserLoginV1',
          "Save a chat browser's signed-in state for a site as a browser login",
          'Conversations',
          chatParams,
          browserLoginSummarySchema,
          { body: saveBrowserLoginSchema },
        ),
      },
      async request => {
        const params = chatParams.parse(request.params);
        const input = saveBrowserLoginSchema.parse(request.body);
        const { client, sessionId } = await session(request, params);
        const userId = user(request);
        const current = await client.state(sessionId);
        if (!current) throw new BrowserHostError('session-not-found', 'The browser has closed');
        const state = await client.siteState(sessionId, input.site);
        if (!state.cookies.length && !state.origins.length) throw new BrowserLoginError('invalid-input');
        // Saving copies the session's sign-in. A login loaded here whose cookies or storage are in the copy, including
        // a parent domain's shared with a sibling site, may only be copied by its managers.
        const domains = [
          ...state.cookies.map(cookie => cookie.domain),
          ...state.origins.map(o => new URL(o.origin).hostname),
        ];
        const copied = current.logins.filter(
          login =>
            siteIncludes(login.site, input.site) ||
            siteIncludes(input.site, login.site) ||
            domains.some(domain => siteIncludes(login.site, domain)),
        );
        if (copied.length) {
          const manageable = new Set(
            (await logins.list(params.workspaceId, userId)).filter(login => login.canManage).map(login => login.id),
          );
          if (copied.some(login => !manageable.has(login.id))) throw new BrowserLoginError('unavailable');
        }
        const saved = await logins.save(params.workspaceId, userId, input, state);
        // The session now holds this login, so its later refreshes and sign-outs are saved back to it.
        await client.loadLogin(sessionId, { id: saved.id, site: saved.site, state });
        return saved;
      },
    );

    routes.post(
      `${chatBase}/:loginId/load`,
      {
        logLevel: 'silent',
        schema: schema(
          'loadConversationBrowserLoginV1',
          "Load a browser login into a chat's browser",
          'Conversations',
          chatLoginParams,
          stateResponse,
        ),
      },
      async request => {
        const { workspaceId, chatId, loginId } = chatLoginParams.parse(request.params);
        const { client, sessionId } = await session(request, { workspaceId, chatId });
        if (!(await client.state(sessionId))) throw new BrowserHostError('session-not-found', 'The browser has closed');
        const login = await logins.use(workspaceId, user(request), loginId);
        return { browser: await client.loadLogin(sessionId, { id: login.id, site: login.site, state: login.state }) };
      },
    );
  });
}
