import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { createAuthoringDrafts } from '@tulipfarm/agents/drafts';
import { draftDecisionSchema, draftOutcomeSchema, draftViewSchema } from '@tulipfarm/agents/draft-contracts';
import { AgentError } from '@tulipfarm/agents/saved-contracts';
import { WorkspaceSkillError } from '@tulipfarm/agents/workspace-skill-contracts';
import { WorkflowConflict } from '@tulipfarm/workflows';
import type { Work } from '@tulipfarm/workflows/contracts';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';
import type { AgentSetupOptions } from '@tulipfarm/agents/setup';

export function registerAuthoringDrafts(
  app: FastifyInstance,
  dependencies: {
    runtime: WorkspaceRuntime;
    auth: ReturnType<typeof registerAuth>['auth'];
    modelFamilyEligibility?: ModelFamilyEligibility | undefined;
    wake?: ((work: Work) => Promise<void>) | undefined;
    agentSetup?: AgentSetupOptions | undefined;
  },
) {
  const service = createAuthoringDrafts(
    dependencies.runtime,
    dependencies.modelFamilyEligibility,
    dependencies.wake,
    dependencies.agentSetup,
  );
  const params = z.strictObject({ workspaceId: z.uuid(), chatId: z.uuid(), draftId: z.uuid() });
  const validation = routeValidation({
    missing: 'Missing draft validator',
    invalid: () => new AgentError('invalid-request', 400),
  });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 503].map(status => [
      status,
      { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    ]),
  );
  app.register(async routes => {
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'draft-unavailable' });
      if (error instanceof AgentError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof WorkspaceSkillError) return reply.code(409).send({ error: error.code });
      if (error instanceof WorkflowConflict)
        return reply.code(409).send({
          error: ['stale-revision', 'stale-generation', 'revision-conflict'].includes(error.message)
            ? 'draft-stale'
            : error.message,
        });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'draft-unavailable' });
    });
    const base = '/workspaces/:workspaceId/conversations/:chatId/drafts/:draftId';
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'readAuthoringDraftV1',
          params: validation.json(params),
          response: { 200: validation.json(draftViewSchema), ...errors },
        },
      },
      request => {
        const p = params.parse(request.params);
        return service.read(p.workspaceId, user(request), p.chatId, p.draftId);
      },
    );
    routes.put(
      `${base}/decision`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'decideAuthoringDraftV1',
          params: validation.json(params),
          body: validation.json(draftDecisionSchema),
          response: { 200: validation.json(draftOutcomeSchema), ...errors },
        },
      },
      request => {
        const p = params.parse(request.params);
        return service.decide(p.workspaceId, user(request), p.chatId, p.draftId, request.body);
      },
    );
  });
}
