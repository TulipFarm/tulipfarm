import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { KnowledgeError, GitHubCorpusError, type GitHubKnowledge } from '@tulipfarm/knowledge';
import { knowledgeCitationSchema } from '@tulipfarm/knowledge/contracts';
import {
  githubKnowledgeConfigureSchema,
  githubKnowledgeManageSchema,
  githubKnowledgeDiscoverSchema,
  githubKnowledgeDiscoverySchema,
  githubKnowledgeListSchema,
  githubKnowledgeSourceSchema,
  githubKnowledgeRefreshSchema,
  githubKnowledgeEvidenceSchema,
  githubKnowledgeStatusSchema,
  githubKnowledgeDocumentsQuerySchema,
  githubKnowledgeDocumentsSchema,
  type GitHubCorpusErrorCode,
} from '@tulipfarm/knowledge/github-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';
import { sendKnowledgeOriginal } from './knowledge-original.ts';
import { googleMembersSchema } from './knowledge-google.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const sourceParams = workspaceParams.extend({ sourceId: z.uuid() });
const documentParams = workspaceParams.extend({ documentId: z.uuid() });
const originalQuery = z.strictObject({ revisionId: z.uuid() });
export const githubDocumentsResponseSchema = githubKnowledgeDocumentsSchema.extend({
  items: z.array(githubKnowledgeDocumentsSchema.shape.items.element.extend({ validUntil: z.iso.datetime() })).max(20),
});
const githubStatus: Record<GitHubCorpusErrorCode, number> = {
  'not-configured': 503,
  'not-linked': 409,
  'stale-integration': 409,
  'reconnect-required': 409,
  'insufficient-scope': 409,
  unauthenticated: 409,
  forbidden: 404,
  'not-found': 404,
  'outside-selection': 404,
  'rate-limited': 429,
  transient: 503,
  'invalid-response': 502,
  'response-too-large': 413,
  'invalid-cursor': 400,
  'invalid-selection': 400,
  'source-changed': 409,
  'too-large': 413,
  unsupported: 415,
};

export function registerGitHubKnowledge(
  app: FastifyInstance,
  dependencies: {
    auth: Parameters<typeof authenticateRoutes>[1];
    service: GitHubKnowledge;
    members: (workspaceId: string, userId: string) => Promise<z.infer<typeof googleMembersSchema>>;
    documents: (
      workspaceId: string,
      userId: string,
      sourceId: string,
      cursor?: string,
    ) => Promise<z.infer<typeof githubDocumentsResponseSchema>>;
  },
) {
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing GitHub Knowledge validator',
      invalid: () => new Error('invalid-request'),
    });
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    const { service } = dependencies;
    const { json } = validation;
    const errorSchema = json(z.strictObject({ error: z.string() }));
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
      if (error instanceof GitHubCorpusError)
        return reply.code(githubStatus[error.code]).send({ error: `github-${error.code}` });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'knowledge-operation-failed' });
    });
    function schema(operationId: string, params: z.ZodType, response: z.ZodType, body?: z.ZodType, query?: z.ZodType) {
      return {
        operationId,
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
    const base = '/workspaces/:workspaceId/knowledge/github';
    routes.get(
      `${base}/members`,
      { logLevel: 'silent', schema: schema('listGitHubKnowledgeMembersV1', workspaceParams, googleMembersSchema) },
      request => dependencies.members(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/discover`,
      {
        logLevel: 'silent',
        schema: schema(
          'discoverGitHubKnowledgeV1',
          workspaceParams,
          githubKnowledgeDiscoverySchema,
          undefined,
          githubKnowledgeDiscoverSchema,
        ),
      },
      request => {
        const { accountId, cursor } = githubKnowledgeDiscoverSchema.parse(request.query);
        return service.discover(workspaceParams.parse(request.params).workspaceId, user(request), accountId, cursor);
      },
    );
    routes.get(
      `${base}/sources`,
      { logLevel: 'silent', schema: schema('listGitHubKnowledgeV1', workspaceParams, githubKnowledgeListSchema) },
      request => service.list(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/sources/:sourceId/documents`,
      {
        logLevel: 'silent',
        schema: schema(
          'listGitHubKnowledgeDocumentsV1',
          sourceParams,
          githubDocumentsResponseSchema,
          undefined,
          githubKnowledgeDocumentsQuerySchema,
        ),
      },
      request => {
        const { workspaceId, sourceId } = sourceParams.parse(request.params);
        return dependencies.documents(
          workspaceId,
          user(request),
          sourceId,
          githubKnowledgeDocumentsQuerySchema.parse(request.query).cursor,
        );
      },
    );
    routes.post(
      `${base}/sources`,
      {
        logLevel: 'silent',
        schema: schema(
          'configureGitHubKnowledgeV1',
          workspaceParams,
          githubKnowledgeSourceSchema,
          githubKnowledgeConfigureSchema,
        ),
      },
      request => service.configure(workspaceParams.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.post(
      `${base}/sources/:sourceId/manage`,
      {
        logLevel: 'silent',
        schema: schema(
          'manageGitHubKnowledgeV1',
          sourceParams,
          githubKnowledgeSourceSchema,
          githubKnowledgeManageSchema,
        ),
      },
      request => {
        const { workspaceId, sourceId } = sourceParams.parse(request.params);
        return service.manage(workspaceId, user(request), sourceId, request.body);
      },
    );
    routes.post(
      `${base}/sources/:sourceId/refresh`,
      { logLevel: 'silent', schema: schema('refreshGitHubKnowledgeV1', sourceParams, githubKnowledgeRefreshSchema) },
      request => {
        const { workspaceId, sourceId } = sourceParams.parse(request.params);
        return service.refresh(workspaceId, user(request), sourceId);
      },
    );
    routes.get(
      `${base}/documents/:documentId`,
      { logLevel: 'silent', schema: schema('statusGitHubKnowledgeV1', documentParams, githubKnowledgeStatusSchema) },
      request => {
        const { workspaceId, documentId } = documentParams.parse(request.params);
        return service.status(workspaceId, user(request), documentId);
      },
    );
    routes.post(
      `${base}/evidence`,
      {
        logLevel: 'silent',
        schema: schema(
          'evidenceGitHubKnowledgeV1',
          workspaceParams,
          githubKnowledgeEvidenceSchema,
          knowledgeCitationSchema,
        ),
      },
      request => service.evidence(workspaceParams.parse(request.params).workspaceId, user(request), request.body),
    );
    const originalSchema = schema('originalGitHubKnowledgeV1', documentParams, z.string(), undefined, originalQuery);
    routes.get(
      `${base}/documents/:documentId/original`,
      {
        logLevel: 'silent',
        schema: {
          ...originalSchema,
          response: { ...originalSchema.response, 200: { type: 'string', format: 'binary' } },
        },
      },
      async (request, reply) => {
        const { workspaceId, documentId } = documentParams.parse(request.params);
        return sendKnowledgeOriginal(
          reply,
          await service.original(workspaceId, user(request), documentId, originalQuery.parse(request.query).revisionId),
        );
      },
    );
  });
}
