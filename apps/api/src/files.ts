import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessDenied, uuidSchema } from '@tulipfarm/access';
import { FileError, type createFiles, type FileMember } from '@tulipfarm/files';
import {
  deletionOutcomeSchema,
  deletionPreviewSchema,
  fileDetailsSchema,
  fileDirectorySchema,
  fileSuggestionsPageSchema,
  fileStorageUsageSchema,
  fileNameSchema,
  fileRoleSchema,
  fileSharingSnapshotSchema,
  fileSubjectSchema,
  fileSummarySchema,
  libraryCursorTokenSchema,
  libraryFiltersSchema,
  libraryPageSchema,
  librarySortSchema,
  librarySectionSchema,
  moveFingerprintSchema,
  movePreviewSchema,
  newFileSchema,
  newFolderSchema,
} from '@tulipfarm/files/contracts';
import { attachmentLimit } from '@tulipfarm/conversations/attachments';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const workspaceParams = z.strictObject({ workspaceId: uuidSchema });
const itemParams = workspaceParams.extend({ fileId: uuidSchema });
const listQuery = z.strictObject({
  parentId: z.union([uuidSchema, z.literal('null')]).optional(),
  query: z.string().max(255).optional(),
  trash: z.enum(['true', 'false']).optional(),
  after: uuidSchema.optional(),
});
const summariesQuery = z.strictObject({
  ids: z
    .string()
    .regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}(,[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}){0,99}$/),
});
const uploadQuery = newFileSchema.extend({ parentId: z.union([uuidSchema, z.literal('null')]).optional() });
const libraryQuery = z.strictObject({
  section: librarySectionSchema,
  folder: uuidSchema.optional(),
  query: z.string().max(255).optional(),
  after: libraryCursorTokenSchema.optional(),
  sort: librarySortSchema.shape.key.optional(),
  order: librarySortSchema.shape.direction.optional(),
  ...libraryFiltersSchema.shape,
});
const suggestionsQuery = z.strictObject({ query: z.string().max(255).optional(), after: uuidSchema.optional() });
const renameBody = z.strictObject({ name: fileNameSchema });
const shareBody = z.strictObject({ subject: fileSubjectSchema, role: fileRoleSchema.nullable() });
const destinationBody = z.strictObject({ parentId: uuidSchema.nullable() });
const moveBody = destinationBody.extend({ fingerprint: moveFingerprintSchema });
const trashBody = z.strictObject({ trashed: z.boolean() });
/** The HTTP status of each Files domain error, shared by every route that calls the Files service. */
export const fileErrorStatus: Record<FileError['code'], number> = {
  conflict: 409,
  'invalid-move': 409,
  integrity: 502,
  size: 413,
  quota: 409,
  busy: 503,
  'graph-limit': 409,
  'invalid-cursor': 400,
  'not-owner': 403,
  'owned-by-others': 409,
  'not-trashed': 409,
  'restore-destination': 409,
};
const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};

export function registerFiles(
  app: FastifyInstance,
  dependencies: {
    auth: Parameters<typeof authenticateRoutes>[1];
    service: ReturnType<typeof createFiles>;
    identity: Pick<Pool, 'query'>;
  },
) {
  const { service } = dependencies;
  async function people(members: FileMember[]) {
    const rows = z
      .array(z.object({ id: z.string(), name: z.string(), email: z.string() }))
      .parse(
        (
          await dependencies.identity.query('SELECT id, name, email FROM app.users WHERE id = ANY($1)', [
            members.map(member => member.userId),
          ])
        ).rows,
      );
    const found = new Map(rows.map(row => [row.id, row]));
    return members.map(member => {
      const user = found.get(member.userId);
      return {
        membershipId: member.membershipId,
        name: user ? user.name.trim() || 'Unnamed member' : 'Former member',
        email: user?.email ?? '',
      };
    });
  }
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing Files validator',
      invalid: () => new Error('invalid-request'),
    });
    const { json } = validation;
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    // The response's `close` fires whether it finished or the sender left. Fastify's onRequestAbort misses a sender
    // that leaves after its body arrived, and onResponse never runs for a destroyed socket, so neither can free the slot.
    const transfers = new Set<FastifyRequest>();
    routes.addHook('onRequest', async (request, reply) => {
      const operation = request.routeOptions.schema?.operationId;
      if (operation !== 'uploadFileV1' && operation !== 'downloadFileV1') return;
      if (transfers.size >= 4) return reply.code(503).send({ error: 'file-busy' });
      transfers.add(request);
      reply.raw.once('close', () => transfers.delete(request));
      itemParams.parse(request.params);
      if (operation === 'uploadFileV1') uploadQuery.parse(request.query);
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'file-not-found' });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'files-unavailable' });
      if (error instanceof FileError) {
        return reply.code(fileErrorStatus[error.code]).send({ error: `file-${error.code}` });
      }
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'file-operation-failed' });
    });
    function schema(operationId: string, params: z.ZodType, response: z.ZodType, body?: z.ZodType, query?: z.ZodType) {
      return {
        operationId,
        tags: ['Files'],
        params: json(params),
        ...(body ? { body: json(body) } : {}),
        ...(query ? { querystring: json(query) } : {}),
        response: {
          200: json(response),
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          413: errorSchema,
          415: errorSchema,
          500: errorSchema,
          502: errorSchema,
          503: errorSchema,
        },
      };
    }
    const base = '/workspaces/:workspaceId/files';
    routes.get(
      `${base}/recent`,
      {
        logLevel: 'silent',
        schema: schema(
          'recentFilesV1',
          workspaceParams,
          fileSuggestionsPageSchema,
          undefined,
          z.strictObject({ after: uuidSchema.optional() }),
        ),
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const { after } = z.object({ after: uuidSchema.optional() }).parse(request.query);
        return service.suggestions(workspaceId, user(request), { query: '', ...(after ? { after } : {}) }, true);
      },
    );
    routes.get(
      `${base}/suggestions`,
      {
        logLevel: 'silent',
        schema: schema('suggestFilesV1', workspaceParams, fileSuggestionsPageSchema, undefined, suggestionsQuery),
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const { query, after } = suggestionsQuery.parse(request.query);
        return service.suggestions(workspaceId, user(request), {
          query: query ?? '',
          ...(after === undefined ? {} : { after }),
        });
      },
    );
    routes.get(
      `${base}/library`,
      {
        logLevel: 'silent',
        schema: schema('fileLibraryV1', workspaceParams, libraryPageSchema, undefined, libraryQuery),
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const { section, folder, query, after, sort, order, ...filters } = libraryQuery.parse(request.query);
        const page = await service.library(workspaceId, user(request), {
          section,
          query: query ?? '',
          filters,
          sort: { key: sort ?? 'name', direction: order ?? (sort === 'modified' ? 'desc' : 'asc') },
          location: folder ? { kind: 'folder', id: folder } : { kind: 'root' },
          ...(after === undefined ? {} : { after }),
        });
        return {
          ...page,
          owners: (await people(page.owners)).map(({ membershipId, name }) => ({ membershipId, name })),
        };
      },
    );
    routes.get(
      `${base}/usage`,
      { logLevel: 'silent', schema: schema('fileStorageUsageV1', workspaceParams, fileStorageUsageSchema) },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.usage(workspaceId, user(request));
      },
    );
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: schema(
          'listFilesV1',
          workspaceParams,
          z.object({ items: z.array(fileSummarySchema), next: uuidSchema.nullable() }),
          undefined,
          listQuery,
        ),
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const query = listQuery.parse(request.query);
        return service.list(workspaceId, user(request), {
          ...query,
          trash: query.trash === 'true',
          parentId: query.parentId === 'null' ? null : query.parentId,
        });
      },
    );
    routes.get(
      `${base}/summaries`,
      {
        logLevel: 'silent',
        schema: schema(
          'readFileSummariesV1',
          workspaceParams,
          z.object({ items: z.array(fileSummarySchema) }),
          undefined,
          summariesQuery,
        ),
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.summaries(workspaceId, user(request), summariesQuery.parse(request.query).ids.split(','));
      },
    );
    routes.get(
      `${base}/:fileId`,
      { logLevel: 'silent', schema: schema('readFileV1', itemParams, fileSummarySchema) },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        return service.read(workspaceId, user(request), fileId);
      },
    );
    routes.post(
      `${base}/:fileId/recent-use`,
      { logLevel: 'silent', schema: schema('recordFileRecentUseV1', itemParams, z.object({ id: uuidSchema })) },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        return service.recordRecentUse(workspaceId, user(request), fileId);
      },
    );
    routes.get(
      `${base}/:fileId/details`,
      { logLevel: 'silent', schema: schema('readFileDetailsV1', itemParams, fileDetailsSchema) },
      async request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        const details = await service.details(workspaceId, user(request), fileId);
        const [owner] = details.owner ? await people([details.owner]) : [];
        return {
          ...details,
          owner: { membershipId: details.item.creatorMembershipId, name: owner?.name ?? 'Former member' },
        };
      },
    );
    routes.get(
      `${base}/:fileId/directory`,
      { logLevel: 'silent', schema: schema('readFileDirectoryV1', itemParams, fileDirectorySchema) },
      async request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        const directory = await service.directory(workspaceId, user(request), fileId);
        return { members: await people(directory.members), teams: directory.teams };
      },
    );
    routes.put(
      `${base}/:fileId/folder`,
      { logLevel: 'silent', schema: schema('createFileFolderV1', itemParams, fileSummarySchema, newFolderSchema) },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        return service.createFolder(workspaceId, user(request), fileId, request.body);
      },
    );
    routes.put(
      `${base}/:fileId/content`,
      {
        logLevel: 'silent',
        bodyLimit: attachmentLimit,
        schema: schema('uploadFileV1', itemParams, fileSummarySchema, undefined, uploadQuery),
      },
      (request, reply) => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        const input = uploadQuery.parse(request.query);
        if (!Buffer.isBuffer(request.body)) throw new FileError('size');
        // A sender that disconnects before the response cancelled the upload, so the file must not commit.
        const sender = new AbortController();
        if (reply.raw.destroyed || request.raw.aborted) sender.abort();
        else
          reply.raw.once('close', () => {
            if (!reply.raw.writableFinished) sender.abort();
          });
        return service.upload(
          workspaceId,
          user(request),
          fileId,
          { ...input, parentId: input.parentId === 'null' || input.parentId === undefined ? null : input.parentId },
          request.body,
          sender.signal,
        );
      },
    );
    const downloadSchema = schema('downloadFileV1', itemParams, z.string());
    routes.get(
      `${base}/:fileId/content`,
      {
        logLevel: 'silent',
        schema: {
          ...downloadSchema,
          response: { ...downloadSchema.response, 200: { type: 'string', format: 'binary' } },
        },
      },
      async (request, reply) => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        const reader = new AbortController();
        if (reply.raw.destroyed || request.raw.aborted) reader.abort();
        else
          reply.raw.once('close', () => {
            if (!reply.raw.writableFinished) reader.abort();
          });
        const result = await service.download(workspaceId, user(request), fileId, reader.signal);
        const filename = encodeURIComponent(result.name).replaceAll("'", '%27');
        return reply
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Disposition', `attachment; filename="file"; filename*=UTF-8''${filename}`)
          .type('application/octet-stream')
          .send(Buffer.from(result.bytes));
      },
    );
    routes.patch(
      `${base}/:fileId`,
      { logLevel: 'silent', schema: schema('renameFileV1', itemParams, fileSummarySchema, renameBody) },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        return service.rename(workspaceId, user(request), fileId, renameBody.parse(request.body).name);
      },
    );
    routes.get(
      `${base}/:fileId/sharing`,
      { logLevel: 'silent', schema: schema('readFileSharingV1', itemParams, fileSharingSnapshotSchema) },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        return service.readSharing(workspaceId, user(request), fileId);
      },
    );
    routes.put(
      `${base}/:fileId/sharing`,
      { logLevel: 'silent', schema: schema('writeFileSharingV1', itemParams, z.object({ id: uuidSchema }), shareBody) },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        const input = shareBody.parse(request.body);
        return service.share(workspaceId, user(request), fileId, input.subject, input.role);
      },
    );
    routes.post(
      `${base}/:fileId/move-audience`,
      { logLevel: 'silent', schema: schema('previewFileMoveV1', itemParams, movePreviewSchema, destinationBody) },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        return service.previewMove(workspaceId, user(request), fileId, destinationBody.parse(request.body).parentId);
      },
    );
    routes.put(
      `${base}/:fileId/parent`,
      {
        logLevel: 'silent',
        schema: schema(
          'moveFileV1',
          itemParams,
          z.object({ id: uuidSchema, parentId: uuidSchema.nullable() }),
          moveBody,
        ),
      },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        const input = moveBody.parse(request.body);
        return service.move(workspaceId, user(request), fileId, input.parentId, input.fingerprint);
      },
    );
    routes.get(
      `${base}/:fileId/deletion`,
      { logLevel: 'silent', schema: schema('previewFileDeletionV1', itemParams, deletionPreviewSchema) },
      async request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        const preview = await service.previewDeletion(workspaceId, user(request), fileId);
        const names = new Map((await people(preview.owners)).map(person => [person.membershipId, person.name]));
        return {
          item: preview.item,
          files: preview.files,
          bytes: preview.bytes,
          blockerCount: preview.blockerCount,
          blockers: preview.blockers.map(({ ownerMembershipId, ...item }) => ({
            ...item,
            owner: { membershipId: ownerMembershipId, name: names.get(ownerMembershipId) ?? 'Former member' },
          })),
        };
      },
    );
    routes.post(
      `${base}/:fileId/delete-forever`,
      { logLevel: 'silent', schema: schema('deleteFileForeverV1', itemParams, deletionOutcomeSchema) },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        return service.deleteForever(workspaceId, user(request), fileId);
      },
    );
    routes.put(
      `${base}/:fileId/trash`,
      {
        logLevel: 'silent',
        schema: schema('trashFileV1', itemParams, z.object({ id: uuidSchema, trashed: z.boolean() }), trashBody),
      },
      request => {
        const { workspaceId, fileId } = itemParams.parse(request.params);
        return service.trash(workspaceId, user(request), fileId, trashBody.parse(request.body).trashed);
      },
    );
  });
}
