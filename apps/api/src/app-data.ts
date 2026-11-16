import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessDenied, type AppActor } from '@tulipfarm/access';
import {
  liveRequestSeconds,
  resolveRequestHandle,
  verifyRequestHandle,
  type LiveAppRequest,
  type RequestHandleKey,
} from '@tulipfarm/apps/store';
import { TableValidationError } from '@tulipfarm/tables/definition';
import type { createTableService } from '@tulipfarm/tables/service';
import { featureFlagAnswer } from '@tulipfarm/observability';
import { createWindows } from './app-data-windows.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

type ViewTables = Pick<
  ReturnType<typeof createTableService>,
  'listThroughView' | 'readThroughView' | 'mutateThroughView'
>;

const field = z.unknown().optional();

/**
 * What an app server can do through one approved view. Each body is checked shallowly here so a body that names a
 * workspace, app, release, viewer or view is refused; the table service parses each field.
 */
const operations = {
  list: {
    operationId: 'listAppDataV1',
    body: z.strictObject({ parameters: field, query: field }),
    run: (tables: ViewTables, workspaceId: string, actor: AppActor, input: unknown) =>
      tables.listThroughView(workspaceId, actor, input),
  },
  read: {
    operationId: 'readAppDataV1',
    body: z.strictObject({ parameters: field, recordId: field }),
    run: async (tables: ViewTables, workspaceId: string, actor: AppActor, input: unknown) => ({
      record: await tables.readThroughView(workspaceId, actor, input),
    }),
  },
  mutate: {
    operationId: 'mutateAppDataV1',
    body: z.strictObject({
      parameters: field,
      kind: field,
      recordId: field,
      expectedToken: field,
      values: field,
    }),
    run: async (tables: ViewTables, workspaceId: string, actor: AppActor, input: unknown) => ({
      record: await tables.mutateThroughView(workspaceId, actor, input),
    }),
  },
};

/**
 * Routes a public app's server calls while it serves a visitor. The `TulipFarm-Request` header the gateway added to
 * that visitor's request is the only authority; no session, cookie or body field can name the app or its release.
 *
 * Every app's sandbox reaches the API from the same address, so nothing here is limited by client address. A handle
 * the gateway did not sign is refused before any other work. A signed handle that no longer resolves is refused from
 * memory for a request's lifetime and charged to nobody, so replaying an old handle cannot spend its app's limits.
 * Only a live request spends its own call limit, then its app's, and only its refusals count towards the app's
 * `refusals` a minute. Every limit lives in this process, which also looks up at most `platformSlots` handles at once
 * and answers 503 beyond that rather than queue for a platform connection.
 */
export function registerAppData(
  app: FastifyInstance,
  dependencies: {
    platform: Pick<Pool, 'query'>;
    handles: RequestHandleKey;
    tables: ViewTables;
    limits?: { request?: number; app?: number; refusals?: number };
  },
) {
  const { request: perRequest = 200, app: perApp = 6_000, refusals = 600 } = dependencies.limits ?? {};
  const windowMs = 60_000;
  const closedHandles = createWindows({ max: 0, windowMs: liveRequestSeconds * 1000 });
  const handleCalls = createWindows({ max: perRequest, windowMs });
  const appCalls = createWindows({ max: perApp, windowMs });
  const appRefusals = createWindows({ max: refusals, windowMs });
  // The platform pool has 10 connections that sign-in and every workspace route also need. A handle lookup is one
  // primary-key read, so 4 in flight keep up with app traffic and always leave 6 connections for everything else.
  const platformSlots = 4;
  let platformWork = 0;
  // The flag provider may evaluate remotely, so each workspace's answer is kept for 30 s and shared by calls in flight.
  // Turning app hosting on or off takes effect within that. A fallback after a failure is not kept.
  const flagMs = 30_000;
  const hosting = new Map<string, { endsAt: number; enabled: Promise<boolean> }>();
  const appHosting = (workspaceId: string) => {
    const held = hosting.get(workspaceId);
    if (held && held.endsAt > Date.now()) return held.enabled;
    const forget = () => {
      if (hosting.get(workspaceId) === entry) hosting.delete(workspaceId);
    };
    const entry = {
      endsAt: Date.now() + flagMs,
      enabled: featureFlagAnswer('app-hosting', null, { id: workspaceId }).then(
        answer => {
          if (!answer.fromProvider) forget();
          return answer.enabled;
        },
        error => {
          forget();
          throw error;
        },
      ),
    };
    hosting.delete(workspaceId);
    if (hosting.size >= 10_000)
      for (const [stale, kept] of hosting) if (kept.endsAt <= Date.now()) hosting.delete(stale);
    if (hosting.size >= 10_000) hosting.delete(hosting.keys().next().value!);
    hosting.set(workspaceId, entry);
    return entry.enabled;
  };

  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing app data validator',
      invalid: e => e,
    });
    validation.install(routes);
    const serving = new WeakMap<FastifyRequest, LiveAppRequest>();
    const closed = (reply: FastifyReply) => reply.code(401).send({ error: 'request-closed' });
    const tooMany = (reply: FastifyReply, ms: number) =>
      reply
        .code(429)
        .header('Retry-After', Math.ceil(ms / 1000))
        .send({ error: 'rate-limit-exceeded' });

    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const signed = verifyRequestHandle(dependencies.handles, request.headers['tulipfarm-request']);
      if (!signed) return closed(reply);
      const handle = createHash('sha256').update(signed.handle).digest('base64url');
      if (closedHandles.wait(handle) > 0) return closed(reply);
      const wait = Math.max(handleCalls.wait(handle), appCalls.wait(signed.appId), appRefusals.wait(signed.appId));
      if (wait > 0) return tooMany(reply, wait);
      if (platformWork >= platformSlots)
        return reply.code(503).header('Retry-After', 1).send({ error: 'temporarily-unavailable' });
      platformWork++;
      let live: LiveAppRequest | null;
      try {
        live = await resolveRequestHandle(dependencies.platform, signed);
      } finally {
        platformWork--;
      }
      if (!live) {
        closedHandles.spend(handle);
        return closed(reply);
      }
      const retry = handleCalls.spend(handle) || appCalls.spend(live.appId);
      if (retry > 0) {
        appRefusals.spend(live.appId);
        return tooMany(reply, retry);
      }
      if (!(await appHosting(live.workspaceId))) {
        appRefusals.spend(live.appId);
        return reply.code(403).send({ error: 'denied' });
      }
      serving.set(request, live);
    });

    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof AccessDenied) {
        const live = serving.get(request);
        if (live) appRefusals.spend(live.appId);
        return reply.code(403).send({ error: 'denied' });
      }
      if (error instanceof TableValidationError)
        return reply.code(422).send({ error: 'invalid-value', fieldId: error.fieldId ?? null, message: error.message });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      if (requestBoundaryError(error, reply)) return;
      request.log.error({ err: error }, 'app_data_failed');
      return reply.code(503).send({ error: 'temporarily-unavailable' });
    });

    for (const [name, operation] of Object.entries(operations))
      routes.post(
        `/app-data/views/:viewId/${name}`,
        {
          schema: {
            operationId: operation.operationId,
            hide: true,
            params: validation.json(z.strictObject({ viewId: z.string() })),
            body: validation.json(operation.body),
          },
        },
        async request => {
          const live = serving.get(request)!;
          const actor: AppActor = { kind: 'app', appId: live.appId, releaseId: live.releaseId };
          const { viewId } = request.params as { viewId: string };
          return operation.run(dependencies.tables, live.workspaceId, actor, { ...(request.body as object), viewId });
        },
      );
  });
}
