import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { KnowledgeError, type DefaultKnowledge } from '@tulipfarm/knowledge';
import {
  defaultKnowledgeIntentSchema,
  defaultKnowledgeListSchema,
  defaultKnowledgeManageSchema,
} from '@tulipfarm/knowledge/default-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const intentParams = workspaceParams.extend({ intentId: z.uuid() });

/** Automatic owner-only Knowledge status and recovery. Every route is gated by `default-connection-knowledge`. */
export function registerDefaultKnowledge(
  app: FastifyInstance,
  dependencies: {
    auth: Parameters<typeof authenticateRoutes>[1];
    service: Pick<DefaultKnowledge, 'list' | 'manage'>;
    enabled: (workspaceId: string, userId: string) => Promise<boolean>;
    started?: (workspaceId: string, intentIds: string[]) => void;
  },
) {
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing default Knowledge validator',
      invalid: () => new Error('invalid-request'),
    });
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    const { json } = validation;
    const errorSchema = json(z.strictObject({ error: z.string() }));
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof SourceAuthorizationUnavailable || error instanceof StorageUnavailableError)
        return reply.code(503).send({ error: 'knowledge-unavailable' });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'knowledge-not-found' });
      if (error instanceof KnowledgeError)
        return reply
          .code(error.code === 'conflict' ? 409 : error.code === 'quota' ? 413 : 503)
          .send({ error: `knowledge-${error.code}` });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'knowledge-operation-failed' });
    });
    function schema(operationId: string, params: z.ZodType, response: z.ZodType, body?: z.ZodType) {
      return {
        operationId,
        tags: ['Knowledge'],
        params: json(params),
        ...(body ? { body: json(body) } : {}),
        response: {
          200: json(response),
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          413: errorSchema,
          500: errorSchema,
          503: errorSchema,
        },
      };
    }
    const base = '/workspaces/:workspaceId/knowledge/defaults';
    routes.get(
      base,
      { logLevel: 'silent', schema: schema('listDefaultKnowledgeV1', workspaceParams, defaultKnowledgeListSchema) },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const userId = user(request);
        // Flag off hides automatic status without touching retained data or manual sources.
        if (!(await dependencies.enabled(workspaceId, userId))) return { enabled: false, items: [] };
        return { enabled: true, items: (await dependencies.service.list(workspaceId, userId)).items };
      },
    );
    routes.post(
      `${base}/:intentId/manage`,
      {
        schema: schema(
          'manageDefaultKnowledgeV1',
          intentParams,
          defaultKnowledgeIntentSchema,
          defaultKnowledgeManageSchema,
        ),
      },
      async request => {
        const { workspaceId, intentId } = intentParams.parse(request.params);
        const userId = user(request);
        if (!(await dependencies.enabled(workspaceId, userId))) throw new AccessDenied();
        const result = await dependencies.service.manage(
          workspaceId,
          userId,
          intentId,
          defaultKnowledgeManageSchema.parse(request.body),
        );
        if (result.state === 'active') dependencies.started?.(workspaceId, [result.intentId]);
        return result;
      },
    );
  });
}
