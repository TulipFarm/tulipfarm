import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessDenied, type AppActor } from '@tulipfarm/access';
import {
  resolveRequestHandle,
  verifyRequestHandle,
  type LiveAppRequest,
  type RequestHandleKey,
} from '@tulipfarm/apps/store';
import { TableValidationError } from '@tulipfarm/tables/definition';
import type { createTableService } from '@tulipfarm/tables/service';
import { isFeatureEnabled } from '@tulipfarm/observability';
import type { createAbuseLimiter } from './abuse.ts';
import { createRefusalBudget } from './app-data-refusals.ts';
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
 * the gateway did not sign is refused before any other work. A signed handle names its app, so every other refusal is
 * charged to that app: once `refusals` of its calls are refused within a minute, or once its call limit or a
 * request's call limit is reached, this process refuses them from memory until the limit resets.
 */
export function registerAppData(
  app: FastifyInstance,
  dependencies: {
    platform: Pick<Pool, 'query'>;
    handles: RequestHandleKey;
    tables: ViewTables;
    limit: ReturnType<typeof createAbuseLimiter>;
    limits?: { request?: number; app?: number; refusals?: number };
  },
) {
  const { request: perRequest = 200, app: perApp = 6_000, refusals = 600 } = dependencies.limits ?? {};
  const appPolicy = { name: 'app-data-app', max: perApp, windowMs: 60_000 };
  const requestPolicy = { name: 'app-data-request', max: perRequest, windowMs: 60_000 };
  const budget = createRefusalBudget({ refusals });

  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing app data validator',
      invalid: e => e,
    });
    validation.install(routes);
    const serving = new WeakMap<FastifyRequest, LiveAppRequest>();
    const tooMany = (reply: FastifyReply, ms: number) =>
      reply
        .code(429)
        .header('Retry-After', Math.ceil(ms / 1000))
        .send({ error: 'rate-limit-exceeded' });

    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const signed = verifyRequestHandle(dependencies.handles, request.headers['tulipfarm-request']);
      if (!signed) return reply.code(401).send({ error: 'request-closed' });
      const wait = budget.wait(signed);
      if (wait > 0) return tooMany(reply, wait);
      // The app's limit comes first so every signed call spends it, whichever request it names.
      const appRetry = await dependencies.limit(appPolicy, signed.appId);
      if (appRetry !== null) {
        budget.holdApp(signed.appId, appRetry);
        budget.refuse(signed.appId);
        return tooMany(reply, appRetry);
      }
      const requestRetry = await dependencies.limit(requestPolicy, signed.handle);
      if (requestRetry !== null) {
        budget.holdHandle(signed.handle, requestRetry);
        budget.refuse(signed.appId);
        return tooMany(reply, requestRetry);
      }
      const live = await resolveRequestHandle(dependencies.platform, signed);
      if (!live) {
        budget.refuse(signed.appId);
        return reply.code(401).send({ error: 'request-closed' });
      }
      if (!(await isFeatureEnabled('app-hosting', null, { id: live.workspaceId }))) {
        budget.refuse(signed.appId);
        return reply.code(403).send({ error: 'denied' });
      }
      serving.set(request, live);
    });

    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof AccessDenied) {
        const live = serving.get(request);
        if (live) budget.refuse(live.appId);
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
