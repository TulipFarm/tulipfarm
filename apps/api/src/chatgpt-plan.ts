import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessDenied, uuidSchema } from '@tulipfarm/access';
import { planProviders } from '@tulipfarm/config';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import {
  ChatGptPlanError,
  chatGptConnectionModes,
  createChatGptPlan,
  parseChatGptCallback,
  type ChatGptPlan,
  type ChatGptPlanRuntime,
} from '@tulipfarm/integrations/chatgpt';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { isFeatureEnabled } from '@tulipfarm/observability';

const preferredPort = 1455;
const callbackPath = '/auth/callback';

/** The member-facing Sign in with ChatGPT service, or null without a workspace runtime. */
export function chatGptPlan(runtime: ChatGptPlanRuntime | undefined, pool: Pool, env: NodeJS.ProcessEnv = process.env) {
  if (!runtime) return null;
  return createChatGptPlan({ runtime, keyring: integrationCredentialKeyring(env), hostId: deploymentHostId(pool) });
}

/**
 * The opaque host id OpenAI asks for: generated once for this deployment and kept in the control database, so it
 * survives restarts, users and key rotations, and carries no user information.
 */
function deploymentHostId(pool: Pool) {
  let cached: Promise<string> | null = null;
  return () =>
    (cached ??= (async () => {
      await pool.query(
        `INSERT INTO app.deployment_identity (name, value) VALUES ('chatgpt-host-id', $1) ON CONFLICT (name) DO NOTHING`,
        [`urn:uuid:${randomUUID()}`],
      );
      const { rows } = await pool.query<{ value: string }>(
        `SELECT value FROM app.deployment_identity WHERE name='chatgpt-host-id'`,
      );
      return z
        .string()
        .regex(/^urn:uuid:[0-9a-f-]{36}$/)
        .parse(rows[0]?.value);
    })().catch(error => {
      cached = null;
      throw error;
    }));
}

/**
 * Sign in with ChatGPT redirects to a 127.0.0.1 loopback. When the browser runs on the API's machine, this listener
 * receives the redirect and completes the sign-in; otherwise the member pastes the failed redirect address instead.
 * It listens only while a sign-in may still arrive.
 */
function loopbackListener(plan: ChatGptPlan, pool: Pool, log: FastifyBaseLogger) {
  let server: Server | null = null;
  let port: number | null = null;
  let starting: Promise<number | null> | null = null;
  let openUntil = 0;
  let timer: NodeJS.Timeout | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    server?.close();
    server = null;
    port = null;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => (Date.now() >= openUntil ? stop() : schedule()), Math.max(1000, openUntil - Date.now()));
    timer.unref();
  };
  async function returnUrl(workspaceId: string | null, outcome: string) {
    const origin = authConfig().webOrigin;
    if (!workspaceId) return origin;
    const { rows } = await pool
      .query<{ slug: string }>('SELECT slug FROM app.workspaces WHERE id=$1', [workspaceId])
      .catch(() => ({ rows: [] as { slug: string }[] }));
    const slug = rows[0]?.slug;
    return slug ? `${origin}/${slug}/settings/models?chatgpt=${encodeURIComponent(outcome)}` : origin;
  }
  async function handle(url: string) {
    let workspaceId: string | null = null;
    try {
      workspaceId = (await plan.complete(url)).workspaceId;
      return returnUrl(workspaceId, 'connected');
    } catch (error) {
      const code = error instanceof ChatGptPlanError ? error.code : 'unavailable';
      if (!(error instanceof ChatGptPlanError))
        log.error({ event: 'chatgpt.loopback.failed' }, 'chatgpt_loopback_failed');
      const state = new URL(url).searchParams.get('state');
      if (state && uuidSchema.safeParse(state.slice(0, 36)).success) workspaceId = state.slice(0, 36);
      return returnUrl(workspaceId, code);
    }
  }
  async function listen() {
    for (const candidate of [preferredPort, 0]) {
      const next = createServer((request, response) => {
        const path = (request.url ?? '').split('?')[0];
        if (request.method !== 'GET' || path !== callbackPath) {
          response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
          return;
        }
        void handle(`http://127.0.0.1:${port}${request.url}`).then(location => {
          // The callback address holds the authorization code, so the browser must not send it on as a referrer.
          response
            .writeHead(303, {
              location,
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'content-type': 'text/html; charset=utf-8',
            })
            .end('<!doctype html><title>TulipFarm</title><p>Return to TulipFarm to finish connecting ChatGPT.</p>');
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          next.once('error', reject);
          next.listen(candidate, '127.0.0.1', () => resolve());
        });
        next.unref();
        server = next;
        port = (next.address() as AddressInfo).port;
        return port;
      } catch {
        next.close();
      }
    }
    return null;
  }
  return {
    /** Keeps the listener open for a new attempt and returns its port, or null when no loopback port is free. */
    async open(seconds: number) {
      openUntil = Math.max(openUntil, Date.now() + seconds * 1000);
      if (!server) {
        starting ??= listen().finally(() => (starting = null));
        await starting;
      }
      if (server) schedule();
      return port;
    },
    close: stop,
  };
}

const errorSchema = z.object({ error: z.string() });
const workspaceParams = z.strictObject({ workspaceId: uuidSchema });
const attemptParams = workspaceParams.extend({ attemptId: uuidSchema });
const modelSchema = z.object({ slug: z.string(), label: z.string() });
const connectionSchema = z.object({
  state: z.enum(['not-connected', 'connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  email: z.string().nullable(),
  planUsage: z.boolean(),
  welcomePending: z.boolean(),
  models: z.array(modelSchema),
});
const beginBody = z.strictObject({ mode: z.enum(chatGptConnectionModes) });
const beginSchema = z.object({
  attemptId: z.uuid(),
  authorizeUrl: z.string(),
  redirectUri: z.string(),
  /** Whether this server listens on the redirect address; without it, the member must paste the address. */
  automatic: z.boolean(),
  expiresInSeconds: z.number(),
});
const attemptSchema = z.object({
  status: z.enum(['pending', 'completed', 'failed']),
  errorCode: z.string().nullable(),
});
const completeBody = z.strictObject({ callbackUrl: z.string().min(1).max(8192) });
const disconnectSchema = z.object({ revoked: z.boolean() });
const okSchema = z.object({ ok: z.literal(true) });
const validation = routeValidation({
  target: 'openapi-3.0',
  missing: 'Missing ChatGPT plan validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
const statuses: Record<string, number> = {
  'attempt-not-found': 404,
  'attempt-expired': 410,
  'callback-invalid': 400,
  'not-connected': 409,
  'reconnect-required': 409,
  'plan-disabled': 409,
  'rate-limited': 429,
  unavailable: 503,
};
function schema(operationId: string, response: z.ZodType) {
  const error = json(errorSchema);
  return {
    operationId,
    tags: ['ChatGPT plan'],
    response: {
      200: json(response),
      400: error,
      401: error,
      403: error,
      404: error,
      409: error,
      410: error,
      429: error,
      503: error,
    },
  };
}

/**
 * Routes for a member's own ChatGPT connection. Without a service, or while the workspace's `chatgpt-plan` feature flag
 * is off, they answer 404 `chatgpt-plan-disabled`.
 */
export function registerChatGptPlan(
  app: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  plan: ChatGptPlan | null,
  pool: Pool,
) {
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, auth, { origin: () => authConfig().webOrigin });
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Referrer-Policy', 'no-referrer');
    });
    routes.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'chatgpt-connection-not-found' });
      if (error instanceof ChatGptPlanError) return reply.code(statuses[error.code] ?? 409).send({ error: error.code });
      if (error.statusCode === 400 || error.validation || error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'unavailable' });
    });
    const base = '/workspaces/:workspaceId/chatgpt/connection';
    if (!plan) {
      // Only the status read stays, so the web app can tell "turned off" from a failure.
      routes.get(
        base,
        { schema: { ...schema('getChatGptConnectionV1', connectionSchema), params: json(workspaceParams) } },
        async (_request, reply) => reply.code(404).send({ error: 'chatgpt-plan-disabled' }),
      );
      return;
    }
    // Members can still disconnect, so turning the plan off never strands a stored token.
    routes.addHook('preHandler', async (request, reply) => {
      if (request.routeOptions.url?.endsWith('/disconnect')) return;
      const { workspaceId } = request.params as { workspaceId: string };
      if (!(await isFeatureEnabled(planProviders.chatgpt.flag, null, { id: workspaceId })))
        return reply.code(404).send({ error: 'chatgpt-plan-disabled' });
    });
    const loopback = loopbackListener(plan, pool, routes.log);
    routes.addHook('onClose', async () => loopback.close());
    routes.get(
      base,
      { schema: { ...schema('getChatGptConnectionV1', connectionSchema), params: json(workspaceParams) } },
      async request => plan.status(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/attempts/:attemptId`,
      { schema: { ...schema('getChatGptConnectionAttemptV1', attemptSchema), params: json(attemptParams) } },
      async request => {
        const { workspaceId, attemptId } = attemptParams.parse(request.params);
        return plan.attempt(workspaceId, user(request), attemptId);
      },
    );
    routes.post(
      `${base}/begin`,
      {
        schema: {
          ...schema('beginChatGptConnectionV1', beginSchema),
          params: json(workspaceParams),
          body: json(beginBody),
        },
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const { mode } = beginBody.parse(request.body);
        const port = await loopback.open(10 * 60);
        const redirectUri = `http://127.0.0.1:${port ?? preferredPort}${callbackPath}`;
        const started = await plan.begin(workspaceId, user(request), mode, redirectUri);
        return {
          attemptId: started.attemptId,
          authorizeUrl: started.authorizeUrl,
          redirectUri,
          automatic: port !== null,
          expiresInSeconds: started.expiresInSeconds,
        };
      },
    );
    routes.post(
      `${base}/complete`,
      {
        schema: {
          ...schema('completeChatGptConnectionV1', connectionSchema),
          params: json(workspaceParams),
          body: json(completeBody),
        },
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const userId = user(request);
        const { callbackUrl } = completeBody.parse(request.body);
        if (parseChatGptCallback(callbackUrl).workspaceId !== workspaceId)
          throw new ChatGptPlanError('attempt-not-found');
        await plan.complete(callbackUrl, userId);
        return plan.status(workspaceId, userId);
      },
    );
    routes.post(
      `${base}/welcome`,
      { schema: { ...schema('acknowledgeChatGptWelcomeV1', okSchema), params: json(workspaceParams) } },
      async request => {
        await plan.acknowledgeWelcome(workspaceParams.parse(request.params).workspaceId, user(request));
        return { ok: true as const };
      },
    );
    routes.post(
      `${base}/disconnect`,
      { schema: { ...schema('disconnectChatGptV1', disconnectSchema), params: json(workspaceParams) } },
      async request => plan.disconnect(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
  });
}
