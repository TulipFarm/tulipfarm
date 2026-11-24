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
const taskParams = z.strictObject({ workspaceId: z.uuid(), taskId: z.uuid() });
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
// The ingress ends a request after 240 s, so the live view ends first and the panel reconnects.
const liveLifetimeMs = 180_000;

/** What owns a browser session: a chat, or an agent's run. */
type Owner = {
  base: string;
  params: z.ZodType<{ workspaceId: string; id: string }>;
  paramsSchema: z.ZodType;
  tag: string;
  operation: string;
  noun: string;
  notFound: string;
  unavailable: string;
  /** Throws `AccessDenied` unless the member may see the chat or run. */
  read(workspaceId: string, userId: string, id: string): Promise<unknown>;
  sessionId(workspaceId: string, id: string): string;
  /** Runs after a member hands the browser back. */
  handedBack?(workspaceId: string, id: string): Promise<void>;
};

function registerLiveRoutes(
  app: FastifyInstance,
  auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>,
  client: BrowserHostClient | undefined,
  streams: Set<() => void>,
  owner: Owner,
) {
  const schema = (operationId: string, summary: string, response: z.ZodType, body?: z.ZodType) => ({
    operationId,
    summary,
    tags: [owner.tag],
    params: json(owner.paramsSchema),
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
  });
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, auth, { origin: () => authConfig().webOrigin });
    routes.setErrorHandler((error, request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: owner.notFound });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: owner.unavailable });
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
    /** Authorizes the reader and returns the host and this owner's browser session. */
    async function session(params: unknown, userId: string) {
      const { workspaceId, id } = owner.params.parse(params);
      await owner.read(workspaceId, userId, id);
      if (!client) throw new BrowserHostError('unavailable', 'Browser use is not configured');
      return { client, sessionId: owner.sessionId(workspaceId, id), workspaceId, id };
    }

    routes.get(
      owner.base,
      {
        logLevel: 'silent',
        schema: schema(`get${owner.operation}BrowserV1`, `Read the state of a ${owner.noun}'s browser`, stateResponse),
      },
      async request => {
        const { workspaceId, id } = owner.params.parse(request.params);
        await owner.read(workspaceId, user(request), id);
        // Without a browser host there is simply no browser.
        if (!client) return { browser: null };
        return { browser: await client.state(owner.sessionId(workspaceId, id)) };
      },
    );

    routes.post(
      `${owner.base}/control`,
      {
        schema: schema(
          `control${owner.operation}BrowserV1`,
          `Take over a ${owner.noun}'s browser or hand it back`,
          stateResponse,
          controlBody,
        ),
      },
      async request => {
        const userId = user(request);
        const { client, sessionId, workspaceId, id } = await session(request.params, userId);
        const { controller } = controlBody.parse(request.body);
        const browser = await client.control(
          sessionId,
          controller === 'person' ? { controller, memberId: userId } : { controller },
        );
        if (controller === 'agent')
          await owner.handedBack?.(workspaceId, id).catch(error => {
            request.log.warn(errorAttributes(error), 'browser_hand_back_wake_failed');
          });
        return { browser };
      },
    );

    routes.post(
      `${owner.base}/input`,
      {
        logLevel: 'silent',
        schema: schema(
          `send${owner.operation}BrowserInputV1`,
          `Send a pointer or key event to a ${owner.noun}'s browser`,
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
      `${owner.base}/live`,
      {
        logLevel: 'silent',
        schema: {
          operationId: `stream${owner.operation}BrowserV1`,
          summary: `Stream a ${owner.noun}'s browser screen and state as server-sent events`,
          tags: [owner.tag],
          params: json(owner.paramsSchema),
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
        const { client, sessionId, workspaceId, id } = await session(request.params, userId);
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
        // A member who loses access stops seeing the browser within half a minute.
        const recheck = () =>
          timers.push(
            setTimeout(async () => {
              try {
                await owner.read(workspaceId, userId, id);
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

/**
 * The live view of a chat's or an agent run's cloud browser. Whoever can read the chat or see the run can watch it,
 * take it over, use it while in control and hand it back. The session is derived from the chat or run, so no other
 * browser is reachable. Handing a run's browser back wakes the run.
 */
export function registerBrowserLive(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    chats: { read(workspaceId: string, userId: string, chatId: string): Promise<unknown> };
    tasks?: {
      read(workspaceId: string, userId: string, taskId: string): Promise<unknown>;
      wake(workspaceId: string, taskId: string): Promise<void>;
    };
    client: BrowserHostClient | undefined;
  },
) {
  const { chats, tasks, client, auth } = dependencies;
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const end of streams) end();
  });
  registerLiveRoutes(app, auth, client, streams, {
    base: '/workspaces/:workspaceId/conversations/:chatId/browser',
    params: chatParams.transform(({ workspaceId, chatId }) => ({ workspaceId, id: chatId })),
    paramsSchema: chatParams,
    tag: 'Conversations',
    operation: 'Conversation',
    noun: 'chat',
    notFound: 'conversation-not-found',
    unavailable: 'conversations-unavailable',
    read: chats.read,
    sessionId: (workspaceId, chatId) => browserSessionId(workspaceId, { conversationId: chatId }),
  });
  if (tasks)
    registerLiveRoutes(app, auth, client, streams, {
      base: '/workspaces/:workspaceId/agent-tasks/:taskId/browser',
      params: taskParams.transform(({ workspaceId, taskId }) => ({ workspaceId, id: taskId })),
      paramsSchema: taskParams,
      tag: 'Agent tasks',
      operation: 'AgentTask',
      noun: 'run',
      notFound: 'task-not-found',
      unavailable: 'task-operation-unavailable',
      read: tasks.read,
      sessionId: (workspaceId, taskId) => browserSessionId(workspaceId, { runId: taskId }),
      handedBack: tasks.wake,
    });
}
