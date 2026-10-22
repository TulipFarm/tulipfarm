import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { humanReadableTableFiles } from '@tulipfarm/agents/table-sources';
import {
  createTableQueryTranslations,
  tableQueryTranslationCompatibility,
  tableSearchTranslator,
  TableQueryTranslationError,
} from '@tulipfarm/agents/table-query-translator';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { createTableService } from '@tulipfarm/tables/service';
import {
  tableQueryTranslationRequestSchema,
  tableQueryTranslationStatusSchema,
  translationErrorSchema,
  translationErrorStatus,
} from '@tulipfarm/tables/translation-contracts';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

/** Natural-language table search. Translation returns a validated query proposal; it never runs the row or summary query. */
export function registerTableQueryTranslations(
  app: FastifyInstance,
  dependencies: { runtime: WorkspaceRuntime; auth: ReturnType<typeof registerAuth>['auth'] },
  env: NodeJS.ProcessEnv = process.env,
) {
  const tables = createTableService(
    dependencies.runtime,
    { readableFiles: humanReadableTableFiles },
    executionCompatibility,
  );
  const translations = createTableQueryTranslations({
    runtime: dependencies.runtime,
    tables,
    provider: tableSearchTranslator(env),
    compatibility: tableQueryTranslationCompatibility,
  });
  const validation = routeValidation({
    missing: 'Missing table search translation validator',
    invalid: () => new Error('invalid-request'),
  });
  const params = z.object({ workspaceId: z.uuid(), tableId: z.uuid() });
  const statusParams = params.extend({ requestId: z.uuid() });
  const errors = Object.fromEntries(
    [400, 401, 402, 403, 404, 409, 429, 503].map(status => [
      status,
      validation.json(status === 401 || status === 403 ? z.object({ error: z.string() }) : translationErrorSchema),
    ]),
  );
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof TableQueryTranslationError)
        return reply.code(translationErrorStatus[error.code]).send({ error: error.code });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'table-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'translation-unavailable' });
    });
    const base = '/workspaces/:workspaceId/tables/:tableId/query';
    routes.post(
      `${base}/translate`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'translateTableQueryV1',
          params: validation.json(params),
          body: validation.json(tableQueryTranslationRequestSchema),
          response: { 200: validation.json(tableQueryTranslationStatusSchema), ...errors },
        },
      },
      request => {
        const p = params.parse(request.params);
        return translations.translate(p.workspaceId, user(request), p.tableId, request.body);
      },
    );
    routes.get(
      `${base}/translations/:requestId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableQueryTranslationStatusV1',
          params: validation.json(statusParams),
          response: { 200: validation.json(tableQueryTranslationStatusSchema), ...errors },
        },
      },
      request => {
        const p = statusParams.parse(request.params);
        return translations.status(p.workspaceId, user(request), p.tableId, p.requestId);
      },
    );
  });
}
