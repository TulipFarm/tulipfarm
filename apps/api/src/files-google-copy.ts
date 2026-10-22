import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied, uuidSchema } from '@tulipfarm/access';
import { FileError, type createFiles } from '@tulipfarm/files';
import { fileNameSchema, fileSummarySchema, newFileSchema } from '@tulipfarm/files/contracts';
import { GoogleWorkspaceError } from '@tulipfarm/google-workspace/contracts';
import { GoogleOperationError } from '@tulipfarm/google-workspace/operation-contracts';
import { GoogleLifecycleError, type createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import {
  GoogleFileError,
  googleExportFormatSchema,
  googleFileReferenceSchema,
} from '@tulipfarm/google-workspace/public-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { fileErrorStatus } from './files.ts';
import { requestBoundaryError } from './security.ts';

const params = z.strictObject({ workspaceId: uuidSchema, fileId: uuidSchema });
const copyBody = z.strictObject({
  name: fileNameSchema,
  parentId: uuidSchema.nullable(),
  source: googleFileReferenceSchema,
  format: z.enum(['original', ...googleExportFormatSchema.options]),
});
const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};

/** Copies one Google file into Files. The file id is the command id: a replay returns the stored copy without reading Google again. */
export function registerFilesGoogleCopy(
  app: FastifyInstance,
  dependencies: {
    auth: Parameters<typeof authenticateRoutes>[1];
    files: ReturnType<typeof createFiles>;
    google: ReturnType<typeof createGoogleOperations>;
  },
) {
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing Google copy validator',
      invalid: () => new Error('invalid-request'),
    });
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'file-not-found' });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'files-unavailable' });
      if (error instanceof FileError)
        return reply.code(fileErrorStatus[error.code]).send({ error: `file-${error.code}` });
      if (error instanceof GoogleFileError)
        return reply
          .code(error.code === 'transfer-busy' ? 429 : error.code === 'transfer-timeout' ? 504 : 409)
          .send({ error: error.code });
      if (
        error instanceof GoogleLifecycleError ||
        error instanceof GoogleOperationError ||
        error instanceof GoogleWorkspaceError
      )
        return reply.code(409).send({ error: error.code });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'file-operation-failed' });
    });
    const recheckSession = async (request: FastifyRequest) => {
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session || session.user.id !== user(request)) throw new AccessDenied();
    };
    routes.put(
      '/workspaces/:workspaceId/files/:fileId/google-copy',
      {
        logLevel: 'silent',
        bodyLimit: 8192,
        schema: {
          operationId: 'copyGoogleFileToFilesV1',
          tags: ['Files'],
          params: validation.json(params),
          body: validation.json(copyBody),
          response: {
            200: validation.json(fileSummarySchema),
            400: errorSchema,
            401: errorSchema,
            403: errorSchema,
            404: errorSchema,
            409: errorSchema,
            413: errorSchema,
            429: errorSchema,
            500: errorSchema,
            502: errorSchema,
            503: errorSchema,
            504: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const { workspaceId, fileId } = params.parse(request.params);
        const input = copyBody.parse(request.body);
        const userId = user(request);
        const abort = new AbortController();
        reply.raw.once('close', () => abort.abort());
        const { fileId: sourceId, expectedIntegration } = input.source;
        const source = {
          provider: 'google-drive' as const,
          accountId: expectedIntegration.accountId,
          fileId: sourceId,
          format: input.format,
        };
        return dependencies.files.importFile(
          workspaceId,
          userId,
          fileId,
          { name: input.name, parentId: input.parentId },
          source,
          async () => {
            const read = await dependencies.google.fileContent(
              workspaceId,
              userId,
              input.format === 'original'
                ? { kind: 'download', fileId: sourceId, expectedIntegration }
                : { kind: 'export', format: input.format, fileId: sourceId, expectedIntegration },
              abort.signal,
            );
            if (read.kind !== 'binary') throw new GoogleFileError('unsupported-representation');
            await recheckSession(request);
            const mediaType = newFileSchema.shape.mediaType.safeParse(read.mimeType.toLowerCase());
            return {
              content: read.bytes,
              mediaType: mediaType.success ? mediaType.data : 'application/octet-stream',
              version: read.version,
            };
          },
        );
      },
    );
  });
}
