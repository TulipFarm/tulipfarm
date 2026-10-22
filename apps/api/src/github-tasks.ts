import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { GitHubAccountError } from '@tulipfarm/github';
import { GitHubReadError, selectAccountSchema, selectionSchema } from '@tulipfarm/github/read-contracts';
import {
  GitHubBatchError,
  batchDecisionSchema,
  batchDisplaySchema,
  batchViewSchema,
  batchStatusSchema,
} from '@tulipfarm/github/batch-contracts';
import type { createGitHubReads } from '@tulipfarm/github/reads';
import type { createGitHubBatches } from '@tulipfarm/github/batches';
import type { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';

export function registerGitHubTasks(
  app: FastifyInstance,
  options: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    reads: ReturnType<typeof createGitHubReads>;
    batches: ReturnType<typeof createGitHubBatches>;
    decide: ReturnType<typeof createGitHubBatchDecision>;
    wake?: (workspaceId: string, taskId: string) => Promise<void>;
  },
) {
  const params = z.strictObject({ workspaceId: z.uuid(), taskId: z.uuid() });
  const item = params.extend({ batchId: z.uuid() });
  const validation = routeValidation({
    target: 'openapi-3.0',
    missing: 'Missing GitHub task validator',
    invalid: () => new Error('invalid-request'),
  });
  const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
  const schema = (operationId: string, response: z.ZodType, parameters: z.ZodType = params, body?: z.ZodType) => ({
    operationId,
    summary: operationId,
    params: validation.json(parameters),
    ...(body ? { body: validation.json(body) } : {}),
    response: {
      200: validation.json(response),
      400: error,
      401: error,
      403: error,
      404: error,
      409: error,
      503: error,
    },
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
    routes.setErrorHandler((failure, _request, reply) => {
      if (failure instanceof AccessDenied) return reply.code(404).send({ error: 'task-unavailable' });
      if (
        failure instanceof GitHubReadError ||
        failure instanceof GitHubBatchError ||
        failure instanceof GitHubAccountError
      )
        return reply.code(409).send({ error: failure.code });
      if (failure instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'task-unavailable' });
    });
    const user = async (headers: Parameters<typeof fromNodeHeaders>[0]) => {
      const session = await options.auth.api.getSession({ headers: fromNodeHeaders(headers) });
      if (!session) throw new AccessDenied();
      return session.user.id;
    };
    const base = '/workspaces/:workspaceId/github/tasks/:taskId';
    routes.get(
      `${base}/selection`,
      { logLevel: 'silent', schema: schema('getGitHubTaskSelectionV1', selectionSchema) },
      async request => {
        const p = params.parse(request.params);
        return options.reads.selection(p.workspaceId, await user(request.headers), { taskId: p.taskId });
      },
    );
    routes.put(
      `${base}/selection`,
      { logLevel: 'silent', schema: schema('selectGitHubTaskAccountV1', selectionSchema, params, selectAccountSchema) },
      async request => {
        const p = params.parse(request.params);
        return options.reads.select(p.workspaceId, await user(request.headers), { taskId: p.taskId }, request.body);
      },
    );
    routes.get(
      `${base}/batches`,
      {
        logLevel: 'silent',
        schema: schema('listGitHubTaskBatchesV1', z.object({ batches: z.array(batchDisplaySchema) })),
      },
      async request => {
        const p = params.parse(request.params);
        return options.batches.list(p.workspaceId, await user(request.headers), { taskId: p.taskId });
      },
    );
    routes.get(
      `${base}/batches/:batchId`,
      { logLevel: 'silent', schema: schema('getGitHubTaskBatchV1', batchViewSchema, item) },
      async request => {
        const p = item.parse(request.params);
        return options.batches.read(p.workspaceId, await user(request.headers), { taskId: p.taskId }, p.batchId);
      },
    );
    for (const action of ['decision', 'reconcile', 'reconcile-status'] as const)
      routes.post(
        `${base}/batches/:batchId/${action}`,
        {
          logLevel: 'silent',
          schema: schema(
            `${action}GitHubTaskBatchV1`,
            action === 'reconcile-status' ? batchStatusSchema : batchViewSchema,
            item,
            action === 'decision' ? batchDecisionSchema : undefined,
          ),
        },
        async request => {
          const p = item.parse(request.params),
            owner = await user(request.headers),
            context = { taskId: p.taskId };
          const result =
            action === 'decision'
              ? await options.decide(p.workspaceId, owner, context, p.batchId, request.body)
              : action === 'reconcile'
                ? await options.batches.reconcile(p.workspaceId, owner, context, p.batchId)
                : await options.batches.reconcileStatus(p.workspaceId, owner, context, p.batchId);
          await options.wake?.(p.workspaceId, p.taskId);
          return result;
        },
      );
    const download = params.extend({ downloadId: z.uuid() });
    routes.get(
      `${base}/downloads/:downloadId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'downloadGitHubTaskFileV1',
          summary: 'Download an owner-authorized retained GitHub task file',
          params: validation.json(download),
          response: { 200: { type: 'string', format: 'binary' }, 401: error, 404: error, 409: error, 503: error },
        },
      },
      async (request, reply) => {
        const p = download.parse(request.params);
        const file = await options.reads.download(
          p.workspaceId,
          await user(request.headers),
          { taskId: p.taskId },
          p.downloadId,
        );
        return reply
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .header('Access-Control-Expose-Headers', 'Content-Disposition')
          .header('X-Content-Type-Options', 'nosniff')
          .type('application/octet-stream')
          .send(file.bytes);
      },
    );
  });
}
