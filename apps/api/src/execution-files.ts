import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import {
  ExecutionConflict,
  executionDownloadSchema,
  executionFilesSchema,
  type createChatExecution,
} from '@tulipfarm/conversations/execution';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import type { registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const params = z.strictObject({ workspaceId: z.uuid(), chatId: z.uuid() });
const listQuery = z.strictObject({ after: z.string().max(4096).optional() });
const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};

export function registerExecutionFiles(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: Pick<ReturnType<typeof createChatExecution>, 'files' | 'download'>;
  },
) {
  const readers = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const reader of readers) reader.abort();
  });
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing execution file request validator',
      invalid: error => error,
    });
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth);
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'execution-not-found' });
      if (error instanceof ExecutionConflict) {
        const status = error.code === 'not-found' ? 404 : error.code === 'disabled' ? 503 : 409;
        return reply.code(status).send({ error: `execution-${error.code}` });
      }
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-request' });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'execution-unavailable' });
      return reply.code(500).send({ error: 'execution-unavailable' });
    });
    function schema(operationId: string, query: z.ZodType, response: object) {
      return {
        operationId,
        tags: ['Conversations'],
        params: validation.json(params),
        querystring: validation.json(query),
        response: {
          200: response,
          400: errorSchema,
          401: errorSchema,
          404: errorSchema,
          409: errorSchema,
          500: errorSchema,
          503: errorSchema,
        },
      };
    }
    const base = '/workspaces/:workspaceId/conversations/:chatId/execution/files';
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: schema('listExecutionFilesV1', listQuery, validation.json(executionFilesSchema)),
      },
      request => {
        const { workspaceId, chatId } = params.parse(request.params);
        const { after } = listQuery.parse(request.query);
        return dependencies.service.files(workspaceId, user(request), chatId, after ?? null);
      },
    );
    routes.get(
      `${base}/content`,
      {
        logLevel: 'silent',
        schema: schema('downloadExecutionFileV1', executionDownloadSchema, { type: 'string', format: 'binary' }),
      },
      async (request, reply) => {
        const { workspaceId, chatId } = params.parse(request.params);
        const reader = new AbortController();
        readers.add(reader);
        const close = () => {
          reader.abort();
          readers.delete(reader);
        };
        reply.raw.once('close', close);
        if (reply.raw.destroyed || request.raw.aborted) close();
        try {
          const result = await dependencies.service.download(
            workspaceId,
            user(request),
            chatId,
            executionDownloadSchema.parse(request.query),
            reader.signal,
          );
          const filename = encodeURIComponent(result.file.path.split('/').at(-1)!).replaceAll("'", '%27');
          return reply
            .header('X-Content-Type-Options', 'nosniff')
            .header('Content-Disposition', `attachment; filename="file"; filename*=UTF-8''${filename}`)
            .header('Content-Length', result.file.size)
            .type('application/octet-stream')
            .send(Readable.from(result.bytes, { objectMode: false }));
        } catch (error) {
          reply.raw.removeListener('close', close);
          close();
          throw error;
        }
      },
    );
  });
}
