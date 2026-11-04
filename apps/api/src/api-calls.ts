import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied, resolveHuman } from '@tulipfarm/access';
import {
  ApiCallDecisionConflict,
  apiCallDecisionSchema,
  apiCallViewSchema,
  decideApiCall,
  listTaskApiCalls,
  viewApiCall,
  type ApiCallOrigin,
} from '@tulipfarm/api-calls';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { errorAttributes } from '@tulipfarm/observability';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

export type ApiCallsHttpAuth = { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> };

const params = z.strictObject({ workspaceId: z.uuid(), callId: z.uuid() });
const taskParams = z.strictObject({ workspaceId: z.uuid(), taskId: z.uuid() });
const taskCallsSchema = z.strictObject({ calls: z.array(apiCallViewSchema) });

export type ApiCallsService = ReturnType<typeof createApiCallReviews>;

/** Reads and decides changes waiting for their member, then wakes the chat or task that waits on them. */
export function createApiCallReviews(options: {
  runtime: WorkspaceRuntime;
  resolveConfirmationCredential: (workspaceId: string) => Promise<string>;
  wakeChat: (workspaceId: string, conversationId: string) => void;
  wakeTask: (workspaceId: string, taskId: string) => Promise<void>;
}) {
  const actorOf = (workspaceId: string, userId: string) =>
    options.runtime.transaction(workspaceId, commonCompatibility, tx => resolveHuman(tx, userId));
  async function wake(workspaceId: string, origin: ApiCallOrigin) {
    if (origin.kind === 'task') return options.wakeTask(workspaceId, origin.taskId);
    await options.runtime.transaction(workspaceId, commonCompatibility, tx =>
      tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_conversation_outbox')} SET next_attempt_at=clock_timestamp() WHERE turn_id=$1 AND generation=$2`,
        [origin.turnId, origin.generation],
      ),
    );
    options.wakeChat(workspaceId, origin.conversationId);
  }
  return {
    async read(workspaceId: string, userId: string, callId: string) {
      const actor = await actorOf(workspaceId, userId);
      const view = await options.runtime.transaction(workspaceId, commonCompatibility, tx =>
        viewApiCall(tx, actor, callId),
      );
      if (!view) throw new AccessDenied();
      return view;
    },
    async listForTask(workspaceId: string, userId: string, taskId: string) {
      const actor = await actorOf(workspaceId, userId);
      return {
        calls: await options.runtime.transaction(workspaceId, commonCompatibility, tx =>
          listTaskApiCalls(tx, actor, taskId),
        ),
      };
    },
    async decide(workspaceId: string, userId: string, callId: string, input: unknown) {
      const actor = await actorOf(workspaceId, userId);
      const decided = await withMaintenanceTransaction({
        connectionString: await options.resolveConfirmationCredential(workspaceId),
        workspaceId,
        capability: 'confirmation',
        operation: tx => decideApiCall(tx, actor, callId, input),
      });
      // The decision is saved; a failed wake only delays the call until the next sweep.
      await wake(workspaceId, decided.origin).catch(() => undefined);
      return decided.view;
    },
  };
}

export function registerApiCalls(app: FastifyInstance, auth: ApiCallsHttpAuth, service: ApiCallsService) {
  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing API call validator',
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
        return reply.code(400).send({ error: 'invalid-api-call-decision' });
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'api-call-not-found' });
      if (error instanceof ApiCallDecisionConflict) return reply.code(409).send({ error: 'api-call-conflict' });
      request.log.error(errorAttributes(error), 'api_call_review_failed');
      return reply.code(503).send({ error: 'api-calls-unavailable' });
    });
    const errorBody = {
      type: 'object',
      properties: { error: { type: 'string' } },
      required: ['error'],
      additionalProperties: false,
    };
    const schema = (
      operationId: string,
      body?: z.ZodType,
      input: z.ZodType = params,
      output: z.ZodType = apiCallViewSchema,
    ) => ({
      operationId,
      tags: ['API calls'],
      params: validation.json(input),
      ...(body ? { body: validation.json(body) } : {}),
      response: {
        200: validation.json(output),
        ...Object.fromEntries([400, 401, 403, 404, 409, 413, 415, 503].map(status => [status, errorBody])),
      },
    });
    const userId = (request: FastifyRequest) => {
      const id = sessions.get(request);
      if (!id) throw new AccessDenied();
      return id;
    };
    routes.get(
      '/workspaces/:workspaceId/agent-tasks/:taskId/api-calls',
      { logLevel: 'silent', schema: schema('listTaskApiCallsV1', undefined, taskParams, taskCallsSchema) },
      request => {
        const p = taskParams.parse(request.params);
        return service.listForTask(p.workspaceId, userId(request), p.taskId);
      },
    );
    const base = '/workspaces/:workspaceId/api-calls/:callId';
    routes.get(base, { logLevel: 'silent', schema: schema('getApiCallV1') }, request => {
      const p = params.parse(request.params);
      return service.read(p.workspaceId, userId(request), p.callId);
    });
    routes.post(
      `${base}/decision`,
      { logLevel: 'silent', bodyLimit: 2048, schema: schema('decideApiCallV1', apiCallDecisionSchema) },
      request => {
        const p = params.parse(request.params);
        return service.decide(p.workspaceId, userId(request), p.callId, apiCallDecisionSchema.parse(request.body));
      },
    );
  });
}
