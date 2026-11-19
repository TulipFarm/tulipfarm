import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { databasePools } from '@tulipfarm/config/database-connections';
import { z } from 'zod';
import { AccessDenied, type AppActor } from '@tulipfarm/access';
import {
  liveRequestSeconds,
  resolveRequestHandle,
  verifyRequestHandle,
  type LiveAppRequest,
  type RequestHandleKey,
  type SignedRequestHandle,
} from '@tulipfarm/apps/store';
import { TableValidationError } from '@tulipfarm/tables/definition';
import type { createTableService } from '@tulipfarm/tables/service';
import { featureFlagAnswer } from '@tulipfarm/observability';
import { busy, createFairSlots } from './app-data-slots.ts';
import { createExpiringMap, createWindows } from './app-data-windows.ts';
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
 * The app data lookup pool. Its connections serve only request handle lookups, at most `max` at once. A lookup that
 * gets no answer in 2 s fails and its connection is dropped, so a half-dead connection cannot hold a slot.
 */
export const appDataLookupPool = {
  max: databasePools.appDataLookups,
  query_timeout: 2_000,
  statement_timeout: 2_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
};

type Verdict = { readonly live: LiveAppRequest; readonly checkedAt: number } | { readonly live: null };
type Verdicts = ReturnType<typeof createExpiringMap<Verdict>>;

/**
 * Routes a public app's server calls while it serves a visitor. The `TulipFarm-Request` header the gateway added to
 * that visitor's request is the only authority; no session, cookie or body field can name the app or its release.
 *
 * Every app's sandbox reaches the API from the same address, so nothing here is limited by client address. A handle
 * the gateway did not sign is refused before any other work. A signed handle is looked up on `lookups`, a pool of
 * `appDataLookupPool.max` connections that nothing else uses, and this process keeps each app's verdicts per handle,
 * apart from other apps': a live one for 5 s, a closed one for 2 minutes. Lookups wait up to 100 ms for a connection,
 * taking turns between apps, and get 503 after that or when 1,000 lookups already wait. An old handle this process
 * has not seen live is live only if a long stream renews it, so each one found closed spends its app's `oldLookups` a
 * minute, and once they are spent the app's unseen old handles get 429. Only a live request spends its own call
 * limit, then its app's, and only its refusals count towards the app's `refusals` a minute. Every limit lives in this
 * process.
 */
export function registerAppData(
  app: FastifyInstance,
  dependencies: {
    lookups: Pick<Pool, 'query'>;
    handles: RequestHandleKey;
    tables: ViewTables;
    limits?: { request?: number; app?: number; refusals?: number; oldLookups?: number };
  },
) {
  const {
    request: perRequest = 200,
    app: perApp = 6_000,
    refusals = 600,
    oldLookups = 120,
  } = dependencies.limits ?? {};
  const windowMs = 60_000;
  // A handle older than this is live only while the gateway renews it for a long stream. The 10 s cover clock skew.
  const freshSeconds = liveRequestSeconds + 10;
  // A live verdict lets a handle keep access for up to 5 s after it closes, and costs a busy request one lookup per 5 s.
  const liveMs = 5_000;
  // A closed handle never opens again. Keeping its verdict 2 minutes covers a fresh handle until it turns old, and
  // keeping a live one that long marks its long stream as seen across the gateway's 20 s renewals.
  const verdictMs = 120_000;
  // A lost verdict can cost its app old lookups and then its unseen long streams, so each app keeps its own 500
  // newest verdicts, which only its own handles push out. A lookup or a live verdict keeps its app's verdicts tracked
  // for 2 more minutes, and a call refused from memory does not, so a replayed closed handle moves no app. Pushing an
  // app out takes lookups for 1,000 other apps since, each with handles the gateway signed for it. An entry takes 200
  // to 450 bytes, so the verdicts take at most about 230 MB.
  const verdicts = createExpiringMap<Verdicts>({ ttlMs: verdictMs, entries: 1_000 });
  const keepVerdicts = (appId: string) => {
    const held = verdicts.get(appId) ?? createExpiringMap<Verdict>({ ttlMs: verdictMs, entries: 500 });
    verdicts.set(appId, held);
    return held;
  };
  const oldClosed = createWindows({ max: oldLookups, windowMs });
  const handleCalls = createWindows({ max: perRequest, windowMs });
  const appCalls = createWindows({ max: perApp, windowMs });
  const appRefusals = createWindows({ max: refusals, windowMs });
  // One app holds at most 2 connections, so another app always waits for one turn at most per waiting app. A waiting
  // lookup leaves when its 100 ms run out, so the queue only fills when lookups arrive faster than 10,000 a second. The
  // cap bounds its memory then, and a call past it is refused at once.
  const slots = createFairSlots({ slots: appDataLookupPool.max, perKey: 2, waitMs: 100, queue: 1_000 });
  const inFlight = new Map<string, Promise<LiveAppRequest | null | typeof busy>>();
  const lookUp = (signed: SignedRequestHandle, digest: string, unseenOld: boolean) => {
    let lookup = inFlight.get(digest);
    if (lookup) return lookup;
    lookup = slots
      .run(signed.appId, async () => {
        // Calls that waited for this slot passed the budget check before the lookups ahead of them spent it.
        if (unseenOld && oldClosed.wait(signed.appId) > 0) return busy;
        const found = await resolveRequestHandle(dependencies.lookups, signed);
        keepVerdicts(signed.appId).set(digest, found ? { live: found, checkedAt: Date.now() } : { live: null });
        if (!found && unseenOld) oldClosed.spend(signed.appId);
        return found;
      })
      .finally(() => inFlight.delete(digest));
    inFlight.set(digest, lookup);
    return lookup;
  };
  // The flag provider may evaluate remotely, so each workspace's answer is kept for 30 s and shared by calls in flight.
  // Turning app hosting on or off takes effect within that. A fallback after a failure is not kept.
  const hosting = createExpiringMap<Promise<boolean>>({ ttlMs: 30_000, entries: 10_000 });
  const appHosting = (workspaceId: string) => {
    const held = hosting.get(workspaceId);
    if (held) return held;
    const forget = () => {
      if (hosting.get(workspaceId) === enabled) hosting.delete(workspaceId);
    };
    const enabled = featureFlagAnswer('app-hosting', null, { id: workspaceId }).then(
      answer => {
        if (!answer.fromProvider) forget();
        return answer.enabled;
      },
      error => {
        forget();
        throw error;
      },
    );
    hosting.set(workspaceId, enabled);
    return enabled;
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
      const digest = createHash('sha256').update(signed.handle).digest('base64url');
      const { appId } = signed;
      const verdict = verdicts.get(appId)?.get(digest);
      if (verdict && !verdict.live) return closed(reply);
      const unseenOld = !verdict && Date.now() / 1000 - signed.mintedAt > freshSeconds;
      const wait = Math.max(
        handleCalls.wait(digest),
        appCalls.wait(appId),
        appRefusals.wait(appId),
        unseenOld ? oldClosed.wait(appId) : 0,
      );
      if (wait > 0) return tooMany(reply, wait);
      const cached = verdict?.live && Date.now() - verdict.checkedAt < liveMs ? verdict.live : null;
      if (cached) keepVerdicts(appId);
      const live = cached ?? (await lookUp(signed, digest, unseenOld));
      if (live === busy) {
        const spent = unseenOld ? oldClosed.wait(appId) : 0;
        if (spent > 0) return tooMany(reply, spent);
        return reply.code(503).header('Retry-After', 1).send({ error: 'temporarily-unavailable' });
      }
      if (!live) return closed(reply);
      const retry = handleCalls.spend(digest) || appCalls.spend(live.appId);
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
