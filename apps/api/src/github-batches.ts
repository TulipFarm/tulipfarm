import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { GitHubAccountError } from '@tulipfarm/github';
import {
  batchDecisionSchema,
  batchDisplaySchema,
  batchStatusSchema,
  batchViewSchema,
  GitHubBatchError,
} from '@tulipfarm/github/batch-contracts';
import type { createGitHubBatches } from '@tulipfarm/github/batches';
import type { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';

export function registerGitHubBatches(
  app: FastifyInstance,
  options: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    batches: ReturnType<typeof createGitHubBatches>;
    decide: ReturnType<typeof createGitHubBatchDecision>;
  },
) {
  const params = z.strictObject({ workspaceId: z.uuid(), conversationId: z.uuid() });
  const item = params.extend({ batchId: z.uuid() });
  const validation = routeValidation({
    target: 'openapi-3.0',
    missing: 'Missing GitHub batch validator',
    invalid: () => new Error('invalid-request'),
  });
  app.register(async routes => {
    validation.install(routes, true);
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (request.method !== 'GET' && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      if (!(await options.auth.api.getSession({ headers: fromNodeHeaders(request.headers) })))
        return reply.code(401).send({ error: 'sign-in-required' });
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'batch-unavailable' });
      if (error instanceof GitHubBatchError || error instanceof GitHubAccountError)
        return reply.code(409).send({ error: error.code });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'batch-unavailable' });
    });
    const base = '/workspaces/:workspaceId/github/chats/:conversationId/batches';
    const user = async (headers: Parameters<typeof fromNodeHeaders>[0]) => {
      const session = await options.auth.api.getSession({ headers: fromNodeHeaders(headers) });
      if (!session) throw new AccessDenied();
      return session.user.id;
    };
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'listGitHubBatchesV1',
          params: validation.json(params),
          response: { 200: validation.json(z.object({ batches: z.array(batchDisplaySchema) })) },
        },
      },
      async request => {
        const p = params.parse(request.params);
        return options.batches.list(p.workspaceId, await user(request.headers), p.conversationId);
      },
    );
    routes.get(
      `${base}/:batchId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'getGitHubBatchV1',
          params: validation.json(item),
          response: { 200: validation.json(batchViewSchema) },
        },
      },
      async request => {
        const p = item.parse(request.params);
        return options.batches.read(p.workspaceId, await user(request.headers), p.conversationId, p.batchId);
      },
    );
    routes.get(
      `${base}/:batchId/status`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'getGitHubBatchStatusV1',
          params: validation.json(item),
          response: { 200: validation.json(batchStatusSchema) },
        },
      },
      async request => {
        const p = item.parse(request.params);
        return options.batches.status(p.workspaceId, await user(request.headers), p.conversationId, p.batchId);
      },
    );
    routes.post(
      `${base}/:batchId/reconcile-status`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'reconcileGitHubBatchStatusV1',
          params: validation.json(item),
          response: { 200: validation.json(batchStatusSchema) },
        },
      },
      async request => {
        const p = item.parse(request.params);
        return options.batches.reconcileStatus(p.workspaceId, await user(request.headers), p.conversationId, p.batchId);
      },
    );
    for (const action of ['decision', 'execute', 'reconcile'] as const)
      routes.post(
        `${base}/:batchId/${action}`,
        {
          logLevel: 'silent',
          schema: {
            operationId: `${action}GitHubBatchV1`,
            params: validation.json(item),
            ...(action === 'decision' ? { body: validation.json(batchDecisionSchema) } : {}),
            response: { 200: validation.json(batchViewSchema) },
          },
        },
        async request => {
          const p = item.parse(request.params),
            userId = await user(request.headers);
          if (action === 'decision') {
            const decided = await options.decide(p.workspaceId, userId, p.conversationId, p.batchId, request.body);
            return decided.decision === 'approve'
              ? options.batches.execute(p.workspaceId, userId, p.conversationId, p.batchId)
              : decided;
          }
          return options.batches[action](p.workspaceId, userId, p.conversationId, p.batchId);
        },
      );
  });
}
