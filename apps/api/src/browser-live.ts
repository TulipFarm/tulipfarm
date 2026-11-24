import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import {
  BrowserHostError,
  browserInputSchema,
  browserSessionId,
  browserSessionStateSchema,
  type BrowserHostClient,
} from '@tulipfarm/browser';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { errorAttributes } from '@tulipfarm/observability';
import type { registerAuth } from './auth.ts';
import { authConfig } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const chatParams = z.strictObject({ workspaceId: z.uuid(), chatId: z.uuid() });
const stateResponse = z.strictObject({ browser: browserSessionStateSchema.nullable() });
const controlBody = z.strictObject({ controller: z.enum(['agent', 'person']) });
const okResponse = z.strictObject({ ok: z.literal(true) });
const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const validation = routeValidation({
  missing: 'Missing browser request validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
function schema(operationId: string, summary: string, response: z.ZodType, body?: z.ZodType) {
  return {
    operationId,
    summary,
    tags: ['Conversations'],
    params: json(chatParams),
    ...(body ? { body: json(body) } : {}),
    response: {
      200: json(response),
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
      409: errorSchema,
      503: errorSchema,
    },
  };
}
// The ingress ends a request after 240 s, so the live view ends first and the panel reconnects.
const liveLifetimeMs = 180_000;

/**
 * The live view of a chat's cloud browser. Whoever can read the chat can watch it, take it over, use it while in
 * control and hand it back. The browser session is derived from the chat, so no other chat's browser is reachable.
 */
export function registerBrowserLive(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    chats: { read(workspaceId: string, userId: string, chatId: string): Promise<unknown> };
    client: BrowserHostClient | undefined;
  },
) {
  const { chats, client } = dependencies;
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const end of streams) end();
  });
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: () => authConfig().webOrigin });
    routes.setErrorHandler((error, request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'conversation-not-found' });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'conversations-unavailable' });
      if (error instanceof BrowserHostError) {
        if (error.code === 'session-not-found') return reply.code(404).send({ error: 'browser-not-found' });
        if (error.code === 'person-in-control' || error.code === 'agent-in-control')
          return reply.code(409).send({ error: error.code });
        if (error.code === 'invalid-request') return reply.code(400).send({ error: 'invalid-request' });
        request.log.warn(errorAttributes(error), 'browser_host_failed');
        return reply.code(503).send({ error: 'browser-unavailable' });
      }
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      request.log.error(errorAttributes(error), 'browser_live_failed');
      return reply.code(503).send({ error: 'browser-unavailable' });
    });
    const base = '/workspaces/:workspaceId/conversations/:chatId/browser';
    /** Authorizes the reader and returns the host and this chat's browser session. */
    async function session(params: unknown, userId: string) {
      const { workspaceId, chatId } = chatParams.parse(params);
      await chats.read(workspaceId, userId, chatId);
      if (!client) throw new BrowserHostError('unavailable', 'Browser use is not configured');
      return { client, sessionId: browserSessionId(workspaceId, { conversationId: chatId }), workspaceId, chatId };
    }

    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: schema('getConversationBrowserV1', "Read the state of a chat's browser", stateResponse),
      },
      async request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        await chats.read(workspaceId, user(request), chatId);
        // Without a browser host the chat simply has no browser.
        if (!client) return { browser: null };
        return { browser: await client.state(browserSessionId(workspaceId, { conversationId: chatId })) };
      },
    );

    routes.post(
      `${base}/control`,
      {
        schema: schema(
          'controlConversationBrowserV1',
          "Take over a chat's browser or hand it back",
          stateResponse,
          controlBody,
        ),
      },
      async request => {
        const userId = user(request);
        const { client, sessionId } = await session(request.params, userId);
        const { controller } = controlBody.parse(request.body);
        return {
          browser: await client.control(
            sessionId,
            controller === 'person' ? { controller, memberId: userId } : { controller },
          ),
        };
      },
    );

    routes.post(
      `${base}/input`,
      {
        logLevel: 'silent',
        schema: schema(
          'sendConversationBrowserInputV1',
          "Send a pointer or key event to a chat's browser",
          okResponse,
          browserInputSchema,
        ),
      },
      async request => {
        const { client, sessionId } = await session(request.params, user(request));
        await client.input(sessionId, browserInputSchema.parse(request.body));
        return { ok: true as const };
      },
    );

    routes.get(
      `${base}/live`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'streamConversationBrowserV1',
          summary: "Stream a chat's browser screen and state as server-sent events",
          tags: ['Conversations'],
          params: json(chatParams),
          response: {
            200: {
              description: 'Live browser frames',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
            401: errorSchema,
            404: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const userId = user(request);
        const { client, sessionId, workspaceId, chatId } = await session(request.params, userId);
        const abort = new AbortController();
        const upstream = await client.frames(sessionId, abort.signal);
        const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>);
        let ended = false;
        const timers: NodeJS.Timeout[] = [];
        function end() {
          if (ended) return;
          ended = true;
          for (const timer of timers) clearTimeout(timer);
          streams.delete(end);
          abort.abort();
          body.destroy();
        }
        streams.add(end);
        reply.raw.once('close', end);
        body.once('error', end);
        timers.push(setTimeout(end, liveLifetimeMs));
        // A member who loses the chat stops seeing its browser within half a minute.
        const recheck = () =>
          timers.push(
            setTimeout(async () => {
              try {
                await chats.read(workspaceId, userId, chatId);
              } catch {
                return end();
              }
              if (!ended) recheck();
            }, 30_000),
          );
        recheck();
        return reply
          .header('Content-Type', 'text/event-stream; charset=utf-8')
          .header('Cache-Control', 'no-cache, no-transform')
          .header('X-Accel-Buffering', 'no')
          .header('Connection', 'keep-alive')
          .send(body);
      },
    );
  });
}
