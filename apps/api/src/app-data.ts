import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessDenied, type AppActor } from '@tulipfarm/access';
import { resolveRequestHandle, type LiveAppRequest } from '@tulipfarm/apps/store';
import { TableValidationError } from '@tulipfarm/tables/definition';
import type { createTableService } from '@tulipfarm/tables/service';
import { isFeatureEnabled } from '@tulipfarm/observability';
import type { createAbuseLimiter } from './abuse.ts';
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

const requestPolicy = { name: 'app-data-request', max: 200, windowMs: 60_000 };
const appPolicy = { name: 'app-data-app', max: 6_000, windowMs: 60_000 };

/**
 * Routes a public app's server calls while it serves a visitor. The `TulipFarm-Request` header the gateway added to
 * that visitor's request is the only authority; no session, cookie or body field can name the app or its release.
 */
export function registerAppData(
  app: FastifyInstance,
  dependencies: {
    platform: Pick<Pool, 'query'>;
    tables: ViewTables;
    limit: ReturnType<typeof createAbuseLimiter>;
  },
) {
  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing app data validator',
      invalid: e => e,
    });
    validation.install(routes);
    const serving = new WeakMap<FastifyRequest, LiveAppRequest>();

    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const header = request.headers['tulipfarm-request'];
      const live = await resolveRequestHandle(dependencies.platform, header);
      if (!live) return reply.code(401).send({ error: 'request-closed' });
      if (!(await isFeatureEnabled('app-hosting', null, { id: live.workspaceId })))
        return reply.code(403).send({ error: 'denied' });
      for (const [policy, identity] of [
        [requestPolicy, String(header)],
        [appPolicy, live.appId],
      ] as const) {
        const retry = await dependencies.limit(policy, identity);
        if (retry !== null) return reply.code(429).header('Retry-After', retry).send({ error: 'rate-limit-exceeded' });
      }
      serving.set(request, live);
    });

    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof AccessDenied) return reply.code(403).send({ error: 'denied' });
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
