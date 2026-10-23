import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { defaultCallTimeoutMs } from '@tulipfarm/config/timeouts';
import { AccessDenied, SourceAuthorizationUnavailable, uuidSchema } from '@tulipfarm/access';
import { FileError } from '@tulipfarm/files';
import {
  KnowledgeError,
  knowledgeSaveSchema,
  knowledgeCommandSchema,
  knowledgeListSchema,
  knowledgeSearchSchema,
  knowledgeDocumentSchema,
  knowledgeCitationSchema,
  knowledgeEvidenceSchema,
  knowledgeSearchResultSchema,
  embeddingQuerySchema,
  embeddingQueryStatusSchema,
  embeddingRetrySchema,
  embeddingDocumentRetrySchema,
  embeddingDocumentStatusSchema,
  knowledgeSourceFailuresSchema,
  type createKnowledgeEmbeddings,
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
const embeddingParams = workspaceParams.extend({ commandId: uuidSchema });
const embeddingStatus = embeddingQueryStatusSchema.omit({ vector: true });
const citationParams = workspaceParams.extend({ citationId: knowledgeCitationIdSchema });
const citationEvidenceSchema = z.object({
  citationId: knowledgeCitationIdSchema,
  title: z.string(),
  heading: z.string(),
  text: z.string(),
  truncated: z.boolean(),
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
    embeddings: ReturnType<typeof createKnowledgeEmbeddings>;
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
  const processing = new Set<Promise<unknown>>();
  app.addHook('onClose', async () => {
    await Promise.allSettled(processing);
  });
  app.addHook('onClose', async () => {
    await dependencies.search?.close();
  });
  async function processQuery(
    workspaceId: string,
    actor: string,
    prepared: Awaited<ReturnType<typeof dependencies.embeddings.prepareQuery>>,
  ) {
    const pending = dependencies.embeddings.process({
      workspaceId,
      jobId: prepared.jobId,
      generation: prepared.generation,
    });
    processing.add(pending);
    try {
      await pending;
    } finally {
      processing.delete(pending);
    }
    return embeddingStatus.parse(await dependencies.embeddings.queryStatus(workspaceId, actor, prepared.commandId));
  }
  app.register(async routes => {
    const deadlines = new WeakMap<FastifyRequest, number>();
    const cancellations = new WeakMap<FastifyRequest, AbortController>();
    routes.addHook('onRequest', async (request, reply) => {
      if (!['searchKnowledgeV2', 'readKnowledgeCitationV1'].includes(request.routeOptions.schema?.operationId ?? ''))
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
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'knowledge-not-found' });
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
          'Search authorized Knowledge with keyword and semantic retrieval',
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
    const document = `${base}/documents/:documentId`;
    routes.post(
      `${base}/query-embeddings`,
      {
        logLevel: 'silent',
        schema: schema(
          'prepareKnowledgeQueryEmbeddingV1',
          'Prepare a private knowledge query embedding',
          workspaceParams,
          embeddingStatus,
          embeddingQuerySchema,
        ),
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const actor = user(request);
        const input = embeddingQuerySchema.parse(request.body);
        const prepared = await dependencies.embeddings.prepareQuery(workspaceId, actor, input);
        return processQuery(workspaceId, actor, prepared);
      },
    );
    routes.get(
      `${base}/query-embeddings/:commandId`,
      {
        logLevel: 'silent',
        schema: schema(
          'readKnowledgeQueryEmbeddingV1',
          'Read private knowledge query embedding status',
          embeddingParams,
          embeddingStatus,
        ),
      },
      async request => {
        const { workspaceId, commandId } = embeddingParams.parse(request.params);
        return embeddingStatus.parse(await dependencies.embeddings.queryStatus(workspaceId, user(request), commandId));
      },
    );
    routes.post(
      `${base}/query-embeddings/:commandId/retry`,
      {
        logLevel: 'silent',
        schema: schema(
          'retryKnowledgeQueryEmbeddingV1',
          'Retry a private knowledge query embedding',
          embeddingParams,
          embeddingStatus,
          embeddingRetrySchema,
        ),
      },
      async request => {
        const { workspaceId, commandId } = embeddingParams.parse(request.params);
        const actor = user(request);
        const prepared = await dependencies.embeddings.retryQuery(
          workspaceId,
          actor,
          commandId,
          embeddingRetrySchema.parse(request.body),
        );
        return processQuery(workspaceId, actor, prepared);
      },
    );
    routes.get(
      `${document}/embeddings`,
      {
        logLevel: 'silent',
        schema: schema(
          'readKnowledgeDocumentEmbeddingV1',
          'Read private knowledge document embedding status',
          documentParams,
          embeddingDocumentStatusSchema,
        ),
      },
      async request => {
        const { workspaceId, documentId } = documentParams.parse(request.params);
        return embeddingDocumentStatusSchema.parse(
          await dependencies.embeddings.documentStatus(workspaceId, user(request), documentId),
        );
      },
    );
    routes.post(
      `${document}/embeddings/retry`,
      {
        logLevel: 'silent',
        schema: schema(
          'retryKnowledgeDocumentEmbeddingV1',
          'Retry a private knowledge document embedding',
          documentParams,
          embeddingDocumentStatusSchema,
          embeddingDocumentRetrySchema,
        ),
      },
      async request => {
        const { workspaceId, documentId } = documentParams.parse(request.params);
        return embeddingDocumentStatusSchema.parse(
          await dependencies.embeddings.retryDocument(
            workspaceId,
            user(request),
            documentId,
            embeddingDocumentRetrySchema.parse(request.body),
          ),
        );
      },
    );
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
          'Search personal knowledge by keyword',
          workspaceParams,
          knowledgeSearchResultSchema,
          undefined,
          knowledgeSearchSchema,
        ),
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.search(workspaceId, user(request), request.query);
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
