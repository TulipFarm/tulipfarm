import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { KnowledgeError, type GoogleKnowledge } from '@tulipfarm/knowledge';
import { knowledgeCitationSchema } from '@tulipfarm/knowledge/contracts';
import {
  googleKnowledgeConfigureSchema,
  googleKnowledgeManageSchema,
  googleKnowledgeDiscoverSchema,
  googleKnowledgeDiscoverySchema,
  googleKnowledgeListSchema,
  googleKnowledgeSourceSchema,
  googleKnowledgeRefreshSchema,
  googleKnowledgeEvidenceSchema,
  googleKnowledgeStatusSchema,
  googleKnowledgeDocumentsQuerySchema,
  googleKnowledgeDocumentsSchema,
} from '@tulipfarm/knowledge/google-contracts';
import { GoogleCorpusError } from '@tulipfarm/google-workspace/corpus';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';
import { sendKnowledgeOriginal } from './knowledge-original.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const sourceParams = workspaceParams.extend({ sourceId: z.uuid() });
const documentParams = workspaceParams.extend({ documentId: z.uuid() });
const originalQuery = z.strictObject({ revisionId: z.uuid() });
export const googleMembersSchema = z.strictObject({
  members: z.array(z.strictObject({ id: z.uuid(), name: z.string(), email: z.email() })),
});
export const googleDocumentsResponseSchema = googleKnowledgeDocumentsSchema.extend({
  items: z.array(googleKnowledgeDocumentsSchema.shape.items.element.extend({ validUntil: z.iso.datetime() })).max(20),
});

export function registerGoogleKnowledge(
  app: FastifyInstance,
  dependencies: {
    auth: Parameters<typeof authenticateRoutes>[1];
    service: GoogleKnowledge;
    members: (workspaceId: string, userId: string) => Promise<z.infer<typeof googleMembersSchema>>;
    documents: (
      workspaceId: string,
      userId: string,
      sourceId: string,
      cursor?: string,
    ) => Promise<z.infer<typeof googleDocumentsResponseSchema>>;
  },
) {
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing Google Knowledge validator',
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
      if (error instanceof GoogleCorpusError) {
        const status = {
          'invalid-selection': 400,
          'invalid-cursor': 400,
          'stale-integration': 409,
          'reconnect-required': 409,
          'insufficient-scope': 409,
          unauthenticated: 409,
          forbidden: 404,
          'not-found': 404,
          'rate-limited': 429,
          transient: 503,
          'invalid-response': 502,
          'response-too-large': 413,
          'incomplete-search': 503,
          restricted: 404,
          'resource-key-required': 409,
          unsupported: 415,
          'attachments-unsupported': 415,
          'mime-unsupported': 415,
          'outside-selection': 404,
          'source-changed': 409,
          'ancestry-limit': 409,
          'credential-unavailable': 503,
        }[error.code];
        return reply.code(status).send({ error: `google-${error.code}` });
      }
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
    const base = '/workspaces/:workspaceId/knowledge/google';
    routes.get(
      `${base}/members`,
      { logLevel: 'silent', schema: schema('listGoogleKnowledgeMembersV1', workspaceParams, googleMembersSchema) },
      request => dependencies.members(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/discover`,
      {
        logLevel: 'silent',
        schema: schema(
          'discoverGoogleKnowledgeV1',
          workspaceParams,
          googleKnowledgeDiscoverySchema,
          undefined,
          googleKnowledgeDiscoverSchema,
        ),
      },
      request => {
        const { kind, cursor } = googleKnowledgeDiscoverSchema.parse(request.query);
        return service.discover(workspaceParams.parse(request.params).workspaceId, user(request), kind, cursor);
      },
    );
    routes.get(
      `${base}/sources`,
      { logLevel: 'silent', schema: schema('listGoogleKnowledgeV1', workspaceParams, googleKnowledgeListSchema) },
      request => service.list(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/sources/:sourceId/documents`,
      {
        logLevel: 'silent',
        schema: schema(
          'listGoogleKnowledgeDocumentsV1',
          sourceParams,
          googleDocumentsResponseSchema,
          undefined,
          googleKnowledgeDocumentsQuerySchema,
        ),
      },
      request => {
        const { workspaceId, sourceId } = sourceParams.parse(request.params);
        return dependencies.documents(
          workspaceId,
          user(request),
          sourceId,
          googleKnowledgeDocumentsQuerySchema.parse(request.query).cursor,
        );
      },
    );
    routes.post(
      `${base}/sources`,
      {
        logLevel: 'silent',
        schema: schema(
          'configureGoogleKnowledgeV1',
          workspaceParams,
          googleKnowledgeSourceSchema,
          googleKnowledgeConfigureSchema,
        ),
      },
      request => service.configure(workspaceParams.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.post(
      `${base}/sources/:sourceId/manage`,
      {
        logLevel: 'silent',
        schema: schema(
          'manageGoogleKnowledgeV1',
          sourceParams,
          googleKnowledgeSourceSchema,
          googleKnowledgeManageSchema,
        ),
      },
      request => {
        const { workspaceId, sourceId } = sourceParams.parse(request.params);
        return service.manage(workspaceId, user(request), sourceId, request.body);
      },
    );
    routes.post(
      `${base}/sources/:sourceId/refresh`,
      { logLevel: 'silent', schema: schema('refreshGoogleKnowledgeV1', sourceParams, googleKnowledgeRefreshSchema) },
      request => {
        const { workspaceId, sourceId } = sourceParams.parse(request.params);
        return service.refresh(workspaceId, user(request), sourceId);
      },
    );
    routes.get(
      `${base}/documents/:documentId`,
      { logLevel: 'silent', schema: schema('statusGoogleKnowledgeV1', documentParams, googleKnowledgeStatusSchema) },
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
          'evidenceGoogleKnowledgeV1',
          workspaceParams,
          googleKnowledgeEvidenceSchema,
          knowledgeCitationSchema,
        ),
      },
      request => service.evidence(workspaceParams.parse(request.params).workspaceId, user(request), request.body),
    );
    const originalSchema = schema('originalGoogleKnowledgeV1', documentParams, z.string(), undefined, originalQuery);
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
