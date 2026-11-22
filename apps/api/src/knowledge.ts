import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { defaultCallTimeoutMs } from '@tulipfarm/config/timeouts';
import { AccessDenied, SourceAuthorizationUnavailable, uuidSchema } from '@tulipfarm/access';
import { FileError } from '@tulipfarm/files';
import {
  KnowledgeAdminRequired,
  KnowledgeError,
  KnowledgeSearchUnavailable,
  knowledgeSettingsSchema,
  knowledgeSettingsUpdateSchema,
  knowledgeSaveSchema,
  knowledgeCommandSchema,
  knowledgeListSchema,
  knowledgeSearchSchema,
  knowledgeDocumentSchema,
  knowledgeCitationSchema,
  knowledgeEvidenceSchema,
  knowledgeSearchResultSchema,
  knowledgeSourceFailuresSchema,
  type createKnowledgeSourceFailures,
  type createLocalKnowledge,
} from '@tulipfarm/knowledge';
import {
  knowledgeSearchRequestSchema,
  knowledgeCitationIdSchema,
  type createKnowledgeSearch,
  type KnowledgeAgentTools,
} from '@tulipfarm/knowledge';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { fileErrorStatus } from './files.ts';
import { requestBoundaryError } from './security.ts';
import { sendKnowledgeOriginal } from './knowledge-original.ts';
import type {
  AtlassianKnowledge,
  GitHubKnowledge,
  GoogleKnowledge,
  SlackKnowledge,
  createConversationKnowledge,
} from '@tulipfarm/knowledge';

const workspaceParams = z.strictObject({ workspaceId: uuidSchema });
const documentParams = workspaceParams.extend({ documentId: uuidSchema });
const sourceParams = workspaceParams.extend({ sourceId: uuidSchema });
const originalQuery = z.strictObject({ revisionId: uuidSchema });
const saveBody = knowledgeSaveSchema.omit({ documentId: true });
const commandBody = knowledgeCommandSchema.omit({ documentId: true });
const citationParams = workspaceParams.extend({ citationId: knowledgeCitationIdSchema });
const citationEvidenceSchema = z.object({
  citationId: knowledgeCitationIdSchema,
  title: z.string(),
  heading: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  location: z.string().optional(),
  source: z.enum(['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation']),
});
const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};

export function registerKnowledge(
  app: FastifyInstance,
  dependencies: {
    auth: Parameters<typeof authenticateRoutes>[1];
    service: ReturnType<typeof createLocalKnowledge>;
    search?: ReturnType<typeof createKnowledgeSearch>;
    citations?: Pick<KnowledgeAgentTools, 'read'>;
    sourceFailures?: ReturnType<typeof createKnowledgeSourceFailures>;
    documentAdapter?: (
      workspaceId: string,
      userId: string,
      documentId: string,
    ) => Promise<
      | Pick<GoogleKnowledge, 'evidence' | 'original'>
      | Pick<SlackKnowledge, 'evidence' | 'original'>
      | Pick<GitHubKnowledge, 'evidence' | 'original'>
      | Pick<AtlassianKnowledge, 'evidence' | 'original'>
      | Pick<ReturnType<typeof createLocalKnowledge>, 'evidence' | 'original'>
      | Pick<ReturnType<typeof createConversationKnowledge>, 'evidence' | 'original'>
    >;
  },
) {
  const { service } = dependencies;
  app.addHook('onClose', async () => {
    await dependencies.search?.close();
  });
  app.register(async routes => {
    const deadlines = new WeakMap<FastifyRequest, number>();
    const cancellations = new WeakMap<FastifyRequest, AbortController>();
    routes.addHook('onRequest', async (request, reply) => {
      if (
        !['searchKnowledgeV1', 'searchKnowledgeV2', 'readKnowledgeCitationV1'].includes(
          request.routeOptions.schema?.operationId ?? '',
        )
      )
        return;
      const deadlineAt = Date.now() + defaultCallTimeoutMs;
      deadlines.set(request, deadlineAt);
      const controller = new AbortController();
      cancellations.set(request, controller);
      let finished = false;
      const timer = setTimeout(() => {
        controller.abort(new StorageUnavailableError('wait_timeout'));
        if (!reply.sent) void reply.code(503).send({ error: 'knowledge-unavailable' });
      }, defaultCallTimeoutMs);
      reply.raw.once('finish', () => {
        finished = true;
        clearTimeout(timer);
      });
      reply.raw.once('close', () => {
        clearTimeout(timer);
        if (!finished) controller.abort();
      });
    });
    const validation = routeValidation({
      missing: 'Missing Knowledge validator',
      invalid: () => new Error('invalid-request'),
    });
    const { json } = validation;
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof SourceAuthorizationUnavailable || error instanceof StorageUnavailableError)
        return reply.code(503).send({ error: 'knowledge-unavailable' });
      if (error instanceof KnowledgeSearchUnavailable)
        return reply.code(503).send({ error: 'knowledge-search-unavailable' });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'knowledge-not-found' });
      if (error instanceof KnowledgeAdminRequired) return reply.code(403).send({ error: 'knowledge-admin-required' });
      if (error instanceof KnowledgeError) {
        const status = {
          conflict: 409,
          quota: 413,
          superseded: 409,
          'permission-expired': 404,
          'adapter-required': 503,
          incomplete: 409,
          integrity: 502,
        }[error.code];
        return reply.code(status).send({ error: `knowledge-${error.code}` });
      }
      if (error instanceof FileError) {
        return reply.code(fileErrorStatus[error.code]).send({ error: `file-${error.code}` });
      }
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'knowledge-operation-failed' });
    });
    function schema(
      operationId: string,
      summary: string,
      params: z.ZodType,
      response: z.ZodType,
      body?: z.ZodType,
      query?: z.ZodType,
    ) {
      return {
        operationId,
        summary,
        tags: ['Knowledge'],
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
          429: errorSchema,
          500: errorSchema,
          502: errorSchema,
          503: errorSchema,
        },
      };
    }
    const base = '/workspaces/:workspaceId/knowledge';
    routes.post(
      `${base}/search`,
      {
        logLevel: 'silent',
        schema: schema(
          'searchKnowledgeV2',
          'Search authorized Knowledge',
          workspaceParams,
          knowledgeSearchResultSchema,
          knowledgeSearchRequestSchema,
        ),
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        if (!dependencies.search) throw new StorageUnavailableError('disabled');
        return dependencies.search.search(
          workspaceId,
          user(request),
          request.body,
          deadlines.get(request),
          cancellations.get(request)?.signal,
        );
      },
    );
    routes.get(
      `${base}/sources/:sourceId/failures`,
      {
        logLevel: 'silent',
        schema: schema(
          'listKnowledgeSourceFailuresV1',
          'List documents in an owned Knowledge source that failed to parse or were indexed from raw text',
          sourceParams,
          knowledgeSourceFailuresSchema,
        ),
      },
      request => {
        const { workspaceId, sourceId } = sourceParams.parse(request.params);
        if (!dependencies.sourceFailures) throw new StorageUnavailableError('disabled');
        return dependencies.sourceFailures.list(workspaceId, user(request), sourceId);
      },
    );
    routes.get(
      `${base}/settings`,
      {
        logLevel: 'silent',
        schema: schema(
          'readKnowledgeSettingsV1',
          'Read workspace Knowledge settings',
          workspaceParams,
          knowledgeSettingsSchema,
        ),
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.settings(workspaceId, user(request));
      },
    );
    routes.put(
      `${base}/settings`,
      {
        logLevel: 'silent',
        schema: schema(
          'updateKnowledgeSettingsV1',
          'Change workspace Knowledge settings. Admins only',
          workspaceParams,
          knowledgeSettingsSchema,
          knowledgeSettingsUpdateSchema,
        ),
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.updateSettings(workspaceId, user(request), knowledgeSettingsUpdateSchema.parse(request.body));
      },
    );
    const document = `${base}/documents/:documentId`;
    routes.get(
      `${base}/documents`,
      {
        logLevel: 'silent',
        schema: schema(
          'listKnowledgeDocumentsV1',
          'List personal knowledge documents',
          workspaceParams,
          z.object({ items: z.array(knowledgeDocumentSchema), nextCursor: uuidSchema.nullable() }),
          undefined,
          knowledgeListSchema,
        ),
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.list(workspaceId, user(request), request.query);
      },
    );
    routes.get(
      document,
      {
        logLevel: 'silent',
        schema: schema(
          'readKnowledgeDocumentV1',
          'Read a personal knowledge document',
          documentParams,
          knowledgeDocumentSchema,
        ),
      },
      request => {
        const { workspaceId, documentId } = documentParams.parse(request.params);
        return service.get(workspaceId, user(request), documentId);
      },
    );
    routes.put(
      document,
      {
        logLevel: 'silent',
        bodyLimit: 10 * 1024 * 1024 + 64 * 1024,
        schema: schema(
          'saveKnowledgeDocumentV1',
          'Save a note or promote a readable File',
          documentParams,
          knowledgeDocumentSchema,
          saveBody,
        ),
      },
      request => {
        const { workspaceId, documentId } = documentParams.parse(request.params);
        return service.save(workspaceId, user(request), { ...saveBody.parse(request.body), documentId });
      },
    );
    routes.post(
      `${document}/retry`,
      {
        logLevel: 'silent',
        schema: schema(
          'retryKnowledgeDocumentV1',
          'Retry a failed knowledge import',
          documentParams,
          knowledgeDocumentSchema,
          commandBody,
        ),
      },
      request => {
        const { workspaceId, documentId } = documentParams.parse(request.params);
        return service.retry(workspaceId, user(request), { ...commandBody.parse(request.body), documentId });
      },
    );
    routes.post(
      `${document}/remove`,
      {
        logLevel: 'silent',
        schema: schema(
          'removeKnowledgeDocumentV1',
          'Remove a knowledge document without deleting its File',
          documentParams,
          z.object({ documentId: uuidSchema, revisionId: uuidSchema, removed: z.literal(true) }),
          commandBody,
        ),
      },
      request => {
        const { workspaceId, documentId } = documentParams.parse(request.params);
        return service.remove(workspaceId, user(request), { ...commandBody.parse(request.body), documentId });
      },
    );
    routes.get(
      `${base}/search`,
      {
        logLevel: 'silent',
        schema: schema(
          'searchKnowledgeV1',
          'Search personal notes and files',
          workspaceParams,
          knowledgeSearchResultSchema,
          undefined,
          knowledgeSearchSchema,
        ),
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        if (!dependencies.search) throw new KnowledgeSearchUnavailable('not-configured');
        const { query } = knowledgeSearchSchema.parse(request.query);
        return dependencies.search.search(
          workspaceId,
          user(request),
          { kind: 'typing', query, filters: { kinds: ['note', 'file'], sourceIds: [], documentIds: [] } },
          deadlines.get(request),
          cancellations.get(request)?.signal,
        );
      },
    );
    routes.post(
      `${base}/evidence`,
      {
        logLevel: 'silent',
        schema: schema(
          'readKnowledgeEvidenceV1',
          'Reauthorize and read knowledge evidence',
          workspaceParams,
          knowledgeEvidenceSchema,
          knowledgeCitationSchema,
        ),
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const citation = knowledgeCitationSchema.parse(request.body);
        const actor = user(request);
        const adapter = (await dependencies.documentAdapter?.(workspaceId, actor, citation.documentId)) ?? service;
        return adapter.evidence(workspaceId, actor, citation);
      },
    );
    routes.get(
      `${base}/citations/:citationId`,
      {
        logLevel: 'silent',
        schema: schema(
          'readKnowledgeCitationV1',
          'Reauthorize and read a passage cited in a chat answer',
          citationParams,
          citationEvidenceSchema,
        ),
      },
      async request => {
        const { workspaceId, citationId } = citationParams.parse(request.params);
        if (!dependencies.citations) throw new StorageUnavailableError('disabled');
        const output = await dependencies.citations.read(workspaceId, user(request), citationId, {
          deadlineAt: deadlines.get(request),
          signal: cancellations.get(request)?.signal,
        });
        const evidence = citationEvidenceSchema.safeParse(output.result);
        if (!evidence.success) throw new AccessDenied();
        return evidence.data;
      },
    );
    const originalSchema = schema(
      'downloadKnowledgeOriginalV1',
      'Download the unchanged knowledge original',
      documentParams,
      z.string(),
      undefined,
      originalQuery,
    );
    routes.get(
      `${document}/original`,
      {
        logLevel: 'silent',
        schema: {
          ...originalSchema,
          response: { ...originalSchema.response, 200: { type: 'string', format: 'binary' } },
        },
      },
      async (request, reply) => {
        const { workspaceId, documentId } = documentParams.parse(request.params);
        const { revisionId } = originalQuery.parse(request.query);
        const actor = user(request);
        const adapter = (await dependencies.documentAdapter?.(workspaceId, actor, documentId)) ?? service;
        return sendKnowledgeOriginal(reply, await adapter.original(workspaceId, actor, documentId, revisionId));
      },
    );
  });
}
