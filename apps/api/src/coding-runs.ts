import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied, resolveHuman } from '@tulipfarm/access';
import { codingRunDecisionSchema, codingRunViewSchema } from '@tulipfarm/agents/coding-run-contracts';
import { CodingRunDecisionConflict, decideCodingRun, viewCodingRun } from '@tulipfarm/agents/coding-run-store';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { errorAttributes } from '@tulipfarm/observability';
import { authConfig } from './auth.ts';
import type { ApiCallsHttpAuth } from './api-calls.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const params = z.strictObject({ workspaceId: z.uuid(), runId: z.uuid() });

export type CodingRunsService = ReturnType<typeof createCodingRunReviews>;

/** Reads and decides coding runs waiting for their member, then wakes the chat that waits on them. */
export function createCodingRunReviews(options: {
  runtime: WorkspaceRuntime;
  resolveConfirmationCredential: (workspaceId: string) => Promise<string>;
  wakeChat: (workspaceId: string, conversationId: string) => void;
}) {
  const actorOf = (workspaceId: string, userId: string) =>
    options.runtime.transaction(workspaceId, commonCompatibility, tx => resolveHuman(tx, userId));
  return {
    async read(workspaceId: string, userId: string, runId: string) {
      const actor = await actorOf(workspaceId, userId);
      const view = await options.runtime.transaction(workspaceId, commonCompatibility, tx =>
        viewCodingRun(tx, actor, runId),
      );
      if (!view) throw new AccessDenied();
      return view;
    },
    async decide(workspaceId: string, userId: string, runId: string, input: unknown) {
      const actor = await actorOf(workspaceId, userId);
      const decided = await withMaintenanceTransaction({
        connectionString: await options.resolveConfirmationCredential(workspaceId),
        workspaceId,
        capability: 'confirmation',
        operation: tx => decideCodingRun(tx, actor, runId, input),
      });
      // The decision is saved; a failed wake only delays the run until the chat's next check.
      await options.runtime
        .transaction(workspaceId, commonCompatibility, tx =>
          tx.client.query(
            `UPDATE ${qualified(tx.schema, 'tf_conversation_outbox')} SET next_attempt_at=clock_timestamp() WHERE turn_id=$1 AND generation=$2`,
            [decided.origin.turnId, decided.origin.generation],
          ),
        )
        .then(() => options.wakeChat(workspaceId, decided.origin.conversationId))
        .catch(() => undefined);
      return decided.view;
    },
  };
}

/** Only the member who asked for a run can read or decide it; anyone else gets `404`. */
export function registerCodingRuns(app: FastifyInstance, auth: ApiCallsHttpAuth, service: CodingRunsService) {
  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing coding run validator',
      invalid: error => error,
    });
    validation.install(routes, true);
    const sessions = new WeakMap<FastifyRequest, string>();
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      sessions.set(request, session.user.id);
    });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-coding-run-decision' });
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'coding-run-not-found' });
      if (error instanceof CodingRunDecisionConflict) return reply.code(409).send({ error: 'coding-run-conflict' });
      request.log.error(errorAttributes(error), 'coding_run_review_failed');
      return reply.code(503).send({ error: 'coding-runs-unavailable' });
    });
    const errorBody = {
      type: 'object',
      properties: { error: { type: 'string' } },
      required: ['error'],
      additionalProperties: false,
    };
    const schema = (operationId: string, body?: z.ZodType) => ({
      operationId,
      tags: ['Coding runs'],
      params: validation.json(params),
      ...(body ? { body: validation.json(body) } : {}),
      response: {
        200: validation.json(codingRunViewSchema),
        ...Object.fromEntries([400, 401, 403, 404, 409, 413, 415, 503].map(status => [status, errorBody])),
      },
    });
    const userId = (request: FastifyRequest) => {
      const id = sessions.get(request);
      if (!id) throw new AccessDenied();
      return id;
    };
    const base = '/workspaces/:workspaceId/coding-runs/:runId';
    routes.get(base, { logLevel: 'silent', schema: schema('getCodingRunV1') }, request => {
      const p = params.parse(request.params);
      return service.read(p.workspaceId, userId(request), p.runId);
    });
    routes.post(
      `${base}/decision`,
      { logLevel: 'silent', bodyLimit: 2048, schema: schema('decideCodingRunV1', codingRunDecisionSchema) },
      request => {
        const p = params.parse(request.params);
        return service.decide(p.workspaceId, userId(request), p.runId, codingRunDecisionSchema.parse(request.body));
      },
    );
  });
}
