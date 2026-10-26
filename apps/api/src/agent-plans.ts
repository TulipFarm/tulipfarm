import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, SourceAuthorizationUnavailable, uuidSchema } from '@tulipfarm/access';
import { createAgentPlans } from '@tulipfarm/agents/plans';
import {
  AgentPlanError,
  planControlSchema,
  planListItemSchema,
  planReceiptSchema,
  planViewSchema,
} from '@tulipfarm/agents/plan-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { authConfig } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

/**
 * Read-only plan outlines for people who can read the chat, and pause, resume and stop for the person who started
 * the plan. People never edit the outline itself; the chat's agents do that through plan tools.
 */
export function registerAgentPlans(
  app: FastifyInstance,
  dependencies: {
    runtime: WorkspaceRuntime;
    auth: Parameters<typeof authenticateRoutes>[1];
    wake?: (workspaceId: string, planId: string) => Promise<void>;
  },
) {
  const service = createAgentPlans(dependencies.runtime);
  const chat = z.strictObject({ workspaceId: uuidSchema, chatId: uuidSchema });
  const plan = z.strictObject({ workspaceId: uuidSchema, planId: uuidSchema });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 500, 503].map(status => [
      status,
      { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    ]),
  );
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing plan validator',
      invalid: () => new Error('invalid-request'),
    });
    const { json } = validation;
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    const schema = (operationId: string, summary: string, params: z.ZodType, output: z.ZodType, body?: z.ZodType) => ({
      operationId,
      summary,
      tags: ['Agent plans'],
      params: json(params),
      ...(body ? { body: json(body) } : {}),
      response: { 200: json(output), ...errors },
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      // A source that cannot be checked right now, say while GitHub is rate limited, is not a removed plan.
      if (error instanceof SourceAuthorizationUnavailable)
        return reply.code(503).send({ error: 'plan-source-unavailable' });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'plan-not-found' });
      if (error instanceof StorageUnavailableError)
        return reply
          .code(error.code === 'disabled' ? 404 : 503)
          .send({ error: error.code === 'disabled' ? 'plan-not-found' : 'plan-operation-unavailable' });
      if (error instanceof AgentPlanError)
        return reply.code(error.code === 'not-starter' ? 403 : 409).send({ error: error.code });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'plan-operation-unavailable' });
    });
    routes.get(
      '/workspaces/:workspaceId/conversations/:chatId/plans',
      {
        schema: schema(
          'listChatPlansV1',
          'List the plans of a chat, newest first',
          chat,
          z.object({ plans: z.array(planListItemSchema) }),
        ),
      },
      async request => {
        const p = chat.parse(request.params);
        return { plans: await service.list(p.workspaceId, user(request), p.chatId) };
      },
    );
    routes.get(
      '/workspaces/:workspaceId/agent-plans/:planId',
      { schema: schema('readAgentPlanV1', 'Read the read-only outline of a plan', plan, planViewSchema) },
      request => {
        const p = plan.parse(request.params);
        return service.read(p.workspaceId, user(request), p.planId);
      },
    );
    routes.post(
      '/workspaces/:workspaceId/agent-plans/:planId/control',
      {
        logLevel: 'silent',
        schema: schema(
          'controlAgentPlanV1',
          'Pause, resume or stop a plan you started',
          plan,
          planReceiptSchema,
          planControlSchema,
        ),
      },
      async request => {
        const p = plan.parse(request.params);
        const receipt = await service.control(p.workspaceId, user(request), p.planId, request.body);
        await dependencies.wake?.(p.workspaceId, p.planId);
        return receipt;
      },
    );
  });
}
