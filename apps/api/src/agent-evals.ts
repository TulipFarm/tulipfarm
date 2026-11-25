import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { SourceAuthorizationUnavailable, uuidSchema } from '@tulipfarm/access';
import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import { evalCaseInputSchema } from '@tulipfarm/evals';
import {
  catalogEligibility,
  createWorkspaceEvals,
  runRequestSchema,
  WorkspaceEvalError,
  workspaceEvalCaseSchema,
  workspaceEvalEstimateSchema,
  workspaceEvalRunDetailSchema,
  workspaceEvalRunSchema,
  workspaceEvalSetSchema,
  type WorkspaceEvals,
} from '@tulipfarm/evals/workspace';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';
import type { createTemporalClient } from './temporal.ts';

type Temporal = ReturnType<typeof createTemporalClient>;

export function createAgentEvals(runtime: WorkspaceRuntime, eligible?: ModelFamilyEligibility) {
  const environment = modelEnvironment();
  return createWorkspaceEvals({ runtime, environment, eligible: eligible ?? catalogEligibility(environment) });
}

function startRun(temporal: Temporal, workspaceId: string, runId: string) {
  return temporal.connection.withDeadline(Date.now() + 10000, () =>
    temporal.client.workflow.start('agentEvalRun', {
      workflowId: `agent-eval-run-v1-${workspaceId}-${runId}`,
      taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
      args: [workspaceId, runId],
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    }),
  );
}

/** Workspace Evals on saved agents. */
export function registerAgentEvals(
  app: FastifyInstance,
  dependencies: {
    auth: ReturnType<typeof registerAuth>['auth'];
    evals: WorkspaceEvals;
    temporal: Temporal;
  },
) {
  const { evals } = dependencies;
  const agent = z.object({ workspaceId: uuidSchema, agentId: uuidSchema });
  const evalCase = agent.extend({ caseId: uuidSchema });
  const run = agent.extend({ runId: uuidSchema });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 422, 500, 503].map(status => [
      status,
      { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    ]),
  );
  const validation = routeValidation({
    missing: 'Missing agent eval validator',
    invalid: () => new WorkspaceEvalError('not-found'),
  });
  const { json } = validation;
  const schema = (operationId: string, params: z.ZodType, output: z.ZodType, body?: z.ZodType) => ({
    operationId,
    tags: ['Agents'],
    params: json(params),
    ...(body ? { body: json(body) } : {}),
    response: { 200: json(output), ...errors },
  });
  app.register(async routes => {
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    validation.install(routes);
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof WorkspaceEvalError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof SourceAuthorizationUnavailable)
        return reply.code(503).send({ error: 'agent-operation-unavailable' });
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'agent-operation-unavailable' });
    });
    const base = '/workspaces/:workspaceId/agents/:agentId/evals';
    routes.get(`${base}`, { schema: schema('getAgentEvalsV1', agent, workspaceEvalSetSchema) }, request => {
      const p = agent.parse(request.params);
      return evals.read(p.workspaceId, user(request), p.agentId);
    });
    routes.post(
      `${base}/cases`,
      { schema: schema('createAgentEvalCaseV1', agent, workspaceEvalCaseSchema, evalCaseInputSchema) },
      request => {
        const p = agent.parse(request.params);
        return evals.createCase(p.workspaceId, user(request), p.agentId, request.body);
      },
    );
    routes.put(
      `${base}/cases/:caseId`,
      { schema: schema('updateAgentEvalCaseV1', evalCase, workspaceEvalCaseSchema, evalCaseInputSchema) },
      request => {
        const p = evalCase.parse(request.params);
        return evals.updateCase(p.workspaceId, user(request), p.agentId, p.caseId, request.body);
      },
    );
    routes.delete(
      `${base}/cases/:caseId`,
      { schema: schema('deleteAgentEvalCaseV1', evalCase, z.object({ deleted: z.literal(true) })) },
      async request => {
        const p = evalCase.parse(request.params);
        await evals.deleteCase(p.workspaceId, user(request), p.agentId, p.caseId);
        return { deleted: true as const };
      },
    );
    const judgeBody = z.strictObject({ judgeModel: z.string().min(1).max(200).nullable() });
    routes.put(`${base}/judge`, { schema: schema('setAgentEvalJudgeV1', agent, judgeBody, judgeBody) }, request => {
      const p = agent.parse(request.params);
      const { judgeModel } = judgeBody.parse(request.body);
      return evals.setJudgeModel(p.workspaceId, user(request), p.agentId, judgeModel);
    });
    routes.post(
      `${base}/estimate`,
      { schema: schema('estimateAgentEvalRunV1', agent, workspaceEvalEstimateSchema, runRequestSchema) },
      request => {
        const p = agent.parse(request.params);
        return evals.estimate(p.workspaceId, user(request), p.agentId, runRequestSchema.parse(request.body));
      },
    );
    routes.post(
      `${base}/runs`,
      { schema: schema('startAgentEvalRunV1', agent, workspaceEvalRunSchema, runRequestSchema) },
      async request => {
        const p = agent.parse(request.params);
        const started = await evals.start(
          p.workspaceId,
          user(request),
          p.agentId,
          runRequestSchema.parse(request.body),
        );
        // The dispatch sweep starts any run this misses.
        await startRun(dependencies.temporal, p.workspaceId, started.id).catch(() =>
          request.log.warn({ workspaceId: p.workspaceId }, 'Agent eval run start will retry'),
        );
        return started;
      },
    );
    routes.get(
      `${base}/runs`,
      { schema: schema('listAgentEvalRunsV1', agent, z.array(workspaceEvalRunSchema)) },
      request => {
        const p = agent.parse(request.params);
        return evals.runs(p.workspaceId, user(request), p.agentId);
      },
    );
    routes.get(
      `${base}/runs/:runId`,
      { schema: schema('getAgentEvalRunV1', run, workspaceEvalRunDetailSchema) },
      request => {
        const p = run.parse(request.params);
        return evals.run(p.workspaceId, user(request), p.agentId, p.runId);
      },
    );
    routes.post(
      `${base}/runs/:runId/cancel`,
      { schema: schema('cancelAgentEvalRunV1', run, workspaceEvalRunSchema) },
      request => {
        const p = run.parse(request.params);
        return evals.cancel(p.workspaceId, user(request), p.agentId, p.runId);
      },
    );
  });
}

/** Starts queued eval runs the API could not start, and fails runs whose worker stopped. */
export function registerAgentEvalDispatch(
  app: FastifyInstance,
  dependencies: { pool: Pool; evals: WorkspaceEvals; temporal: Temporal },
) {
  let after: string | null = null;
  backgroundSweep(
    app,
    async stopped => {
      const workspaces = await readyWorkspaces(dependencies.pool, after, 100);
      for (const workspace of workspaces) {
        if (stopped()) return;
        try {
          for (const runId of await dependencies.evals.pending(workspace.workspace_id))
            await startRun(dependencies.temporal, workspace.workspace_id, runId);
        } catch {
          app.log.error({ workspaceId: workspace.workspace_id }, 'Agent eval dispatch will retry');
        }
        after = workspace.workspace_id;
      }
      if (workspaces.length < 100) after = null;
    },
    'Agent eval discovery will retry',
    'agent-eval-dispatch',
  );
}
