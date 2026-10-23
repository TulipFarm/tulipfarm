import type { FastifyInstance } from 'fastify';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import { z } from 'zod';
import { AccessDenied, SourceAuthorizationUnavailable, uuidSchema } from '@tulipfarm/access';
import { createAgentAuthoring } from '@tulipfarm/agents/authoring';
import { createSavedAgentService } from '@tulipfarm/agents/saved-service';
import { createAgentSchedules } from '@tulipfarm/agents/schedules';
import {
  createAgentChat,
  retryModelSchema,
  retryModelReceiptSchema,
  type ModelContinuity,
} from '@tulipfarm/agents/chat';
import { chatInputSchema, chatReceiptSchema, chatStatusSchema } from '@tulipfarm/agents/chat-contracts';
import { inspectionActivationSchema, scheduleInputSchema, scheduleSchema } from '@tulipfarm/agents/schedule-contracts';
import { agentCalendarSchema } from '@tulipfarm/agents/schedule-contracts';
import { calendarRangeSchema } from '@tulipfarm/workflows/calendar-contracts';
import {
  agentDefinitionSchema,
  executionPolicySchema,
  maximumTaskLimits,
  scopeSchema,
  taskLimitsSchema,
} from '@tulipfarm/agents/contracts';
import {
  AgentError,
  agentCommandStatusSchema,
  agentContextSchema,
  agentListSchema,
  agentPolicySchema,
  saveAgentSchema,
  savedAgentSchema,
} from '@tulipfarm/agents/saved-contracts';
import { readVerifiedProjection } from '@tulipfarm/workspaces/soul-revisions';
import { soulStorageConfig } from '@tulipfarm/workspaces/soul';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { Pool } from 'pg';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';
import { createModelPolicyService, type ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import {
  modelFamilyIdSchema,
  modelPolicyCommandSchema,
  modelPolicyReceiptSchema,
  modelPolicyRuleSchema,
} from '@tulipfarm/agents/model-policy-contracts';
import {
  compactionPolicyCommandSchema,
  compactionPolicyReceiptSchema,
  compactionPolicySchema,
} from '@tulipfarm/agents/compaction-policy-contracts';
import { createCompactionPolicyService } from '@tulipfarm/agents/compaction-policy';
import {
  imageSettingsCommandSchema,
  imageSettingsReceiptSchema,
  imageSettingsSchema,
} from '@tulipfarm/agents/image-settings-contracts';
import { createImageSettingsService } from '@tulipfarm/agents/image-settings';
import {
  modelAvailabilityListSchema,
  modelAvailabilityCommandSchema,
  modelAvailabilityReceiptSchema,
} from '@tulipfarm/agents/model-policy-contracts';
import { createIntegrationService, integrationCredentialKeyring } from '@tulipfarm/integrations';
import { googleOperations } from './google-composition.ts';
import { slackActionsFromEnvironment } from '@tulipfarm/agents/slack-environment';
import { definitionSharingCandidatesSchema } from '@tulipfarm/agents/saved-contracts';
import { createAgentSetup, type AgentSetupOptions } from '@tulipfarm/agents/setup';
import {
  agentSetupDraftSchema,
  agentSetupReceiptSchema,
  publishAgentSetupSchema,
  saveAgentSetupDraftSchema,
} from '@tulipfarm/agents/setup-contracts';

export function registerAgents(
  app: FastifyInstance,
  dependencies: {
    auth: ReturnType<typeof registerAuth>['auth'];
    runtime: WorkspaceRuntime;
    pool: Pool;
    agentModel?: ModelContinuity | null | undefined;
    modelFamilyEligibility?: ModelFamilyEligibility | undefined;
    agentSetup?: AgentSetupOptions | undefined;
  },
) {
  let storage: ReturnType<typeof soulStorageConfig> | undefined =
    process.env.NODE_ENV === 'production' ? soulStorageConfig('read') : undefined;
  const service = createSavedAgentService(dependencies.runtime, (workspaceId, projection) => {
    storage ??= soulStorageConfig('read');
    return readVerifiedProjection(storage, workspaceId, projection);
  });
  app.addHook('onClose', async () => {
    storage?.client.destroy();
  });
  const commands = createAgentAuthoring(dependencies.runtime, dependencies.modelFamilyEligibility);
  const models = createModelPolicyService(dependencies.runtime, dependencies.modelFamilyEligibility);
  const compaction = createCompactionPolicyService(dependencies.runtime, dependencies.modelFamilyEligibility);
  const images = createImageSettingsService(dependencies.runtime);
  const schedules = createAgentSchedules(dependencies.runtime);
  const setup = createAgentSetup(dependencies.runtime, dependencies.modelFamilyEligibility, dependencies.agentSetup);
  const chat = createAgentChat(
    dependencies.runtime,
    dependencies.agentModel ?? null,
    {
      readIssue: (workspaceId, actor, input) =>
        createIntegrationService({ runtime: dependencies.runtime, keyring: integrationCredentialKeyring() }).readIssue(
          workspaceId,
          actor,
          input,
        ),
    },
    googleOperations,
    undefined,
    slackActionsFromEnvironment(),
  );
  let after: string | null = null;
  async function sweepChat(stopped: () => boolean) {
    const rows = await readyWorkspaces(dependencies.pool, after, 20);
    await Promise.all(
      rows.map(async row => {
        if (stopped()) return;
        try {
          const [id] = await chat.pending(row.workspace_id);
          if (id && !stopped()) await chat.processTurn(row.workspace_id, id);
        } catch {
          app.log.error({ workspaceId: row.workspace_id }, 'Agent chat will retry');
        }
      }),
    );
    after = rows.length < 20 ? null : (rows.at(-1)?.workspace_id ?? null);
  }
  backgroundSweep(app, sweepChat, 'Agent chat discovery will retry', 'agent-chat-discovery', false);
  let setupAfter: string | null = null;
  backgroundSweep(
    app,
    async stopped => {
      const rows = await readyWorkspaces(dependencies.pool, setupAfter, 20);
      for (const row of rows) {
        if (stopped()) return;
        try {
          for (const command of await setup.pending(row.workspace_id)) {
            if (stopped()) return;
            await setup.advance(row.workspace_id, command.user_id, command.id);
          }
        } catch {
          app.log.error({ workspaceId: row.workspace_id }, 'Agent setup will retry');
        }
      }
      setupAfter = rows.length < 20 ? null : (rows.at(-1)?.workspace_id ?? null);
    },
    'Agent setup discovery will retry',
    'agent-setup-discovery',
  );
  const origin = authConfig().webOrigin;
  const workspace = z.object({ workspaceId: uuidSchema });
  const agent = workspace.extend({ agentId: uuidSchema });
  const success = z.object({ saved: z.boolean() });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 500, 503].map(status => [
      status,
      { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    ]),
  );
  const validation = routeValidation({
    missing: 'Missing agent validator',
    invalid: () => new AgentError('invalid-request', 400),
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
    const user = authenticateRoutes(routes, dependencies.auth, { origin });
    validation.install(routes);
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof SourceAuthorizationUnavailable)
        return reply.code(503).send({ error: 'agent-operation-unavailable' });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'agent-not-found' });
      if (error instanceof AgentError) return reply.code(error.status).send({ error: error.code });
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'agent-operation-unavailable' });
    });
    const base = '/workspaces/:workspaceId/agents';
    routes.get(
      `${base}/calendar`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('agentCalendarV1', workspace, agentCalendarSchema),
          querystring: json(calendarRangeSchema),
        },
      },
      request => schedules.calendar(workspace.parse(request.params).workspaceId, user(request), request.query),
    );
    const setupCommand = workspace.extend({ commandId: uuidSchema });
    routes.get(
      `${base}/setup-commands/:commandId`,
      { schema: schema('getAgentSetupCommandV1', setupCommand, agentSetupReceiptSchema) },
      request => {
        const p = setupCommand.parse(request.params);
        return setup.readCommand(p.workspaceId, user(request), p.commandId);
      },
    );
    routes.post(
      `${base}/setup-commands/:commandId/retry`,
      { schema: schema('retryAgentSetupCommandV1', setupCommand, agentSetupReceiptSchema) },
      request => {
        const p = setupCommand.parse(request.params);
        return setup.advance(p.workspaceId, user(request), p.commandId);
      },
    );
    routes.get(
      `${base}/:agentId/setup-draft`,
      { schema: schema('getAgentSetupDraftV1', agent, agentSetupDraftSchema) },
      request => {
        const p = agent.parse(request.params);
        return setup.readDraft(p.workspaceId, user(request), p.agentId);
      },
    );
    routes.put(
      `${base}/:agentId/setup-draft`,
      { schema: schema('saveAgentSetupDraftV1', agent, agentSetupDraftSchema, saveAgentSetupDraftSchema) },
      request => {
        const p = agent.parse(request.params);
        return setup.saveDraft(p.workspaceId, user(request), p.agentId, request.body);
      },
    );
    routes.post(
      `${base}/:agentId/setup`,
      { schema: schema('publishAgentSetupV1', agent, agentSetupReceiptSchema, publishAgentSetupSchema) },
      async request => {
        const p = agent.parse(request.params),
          actor = user(request);
        const command = await setup.publish(p.workspaceId, actor, p.agentId, request.body);
        return setup.advance(p.workspaceId, actor, command.commandId);
      },
    );
    routes.get(
      `${base}/recent`,
      { schema: schema('recentAgentsV1', workspace, z.array(z.object({ id: uuidSchema, name: z.string() }))) },
      request => service.recent(workspace.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/sharing-candidates`,
      { schema: schema('agentSharingCandidatesV1', workspace, definitionSharingCandidatesSchema) },
      async request => {
        const candidates = await service.sharingCandidates(workspace.parse(request.params).workspaceId, user(request));
        const users = z
          .array(z.object({ id: z.string(), name: z.string(), email: z.string() }))
          .parse(
            (
              await dependencies.pool.query('SELECT id,name,email FROM app.users WHERE id=ANY($1)', [
                candidates.people.map(person => person.userId),
              ])
            ).rows,
          );
        return {
          ...candidates,
          people: candidates.people.map(person => ({
            ...person,
            name: users.find(item => item.id === person.userId)?.name ?? 'Workspace member',
            email: users.find(item => item.id === person.userId)?.email ?? '',
          })),
        };
      },
    );
    const modelBase = '/workspaces/:workspaceId/model-policy';
    const family = workspace.extend({ sourceFamilyId: modelFamilyIdSchema });
    routes.get(
      `${modelBase}/rules/:sourceFamilyId`,
      { schema: schema('getModelFallbackRuleV1', family, modelPolicyRuleSchema) },
      request => {
        const p = family.parse(request.params);
        return models.read(p.workspaceId, user(request), p.sourceFamilyId);
      },
    );
    routes.put(
      modelBase,
      { schema: schema('saveModelFallbackRuleV1', workspace, modelPolicyReceiptSchema, modelPolicyCommandSchema) },
      request => models.save(workspace.parse(request.params).workspaceId, user(request), request.body),
    );
    const modelCommand = workspace.extend({ requestId: uuidSchema });
    routes.get(
      `${modelBase}/availability`,
      { schema: schema('getModelAvailabilityV1', workspace, modelAvailabilityListSchema) },
      request => models.availability(workspace.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      `${modelBase}/availability`,
      {
        schema: schema(
          'saveModelAvailabilityV1',
          workspace,
          modelAvailabilityReceiptSchema,
          modelAvailabilityCommandSchema,
        ),
      },
      request => models.saveAvailability(workspace.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.get(
      `${modelBase}/availability/commands/:requestId`,
      { schema: schema('getModelAvailabilityCommandV1', modelCommand, modelAvailabilityReceiptSchema) },
      request => {
        const p = modelCommand.parse(request.params);
        return models.availabilityCommandStatus(p.workspaceId, user(request), p.requestId);
      },
    );
    routes.get(
      `${modelBase}/images`,
      { schema: schema('getImageSettingsV1', workspace, imageSettingsSchema) },
      request => images.read(workspace.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      `${modelBase}/images`,
      { schema: schema('saveImageSettingsV1', workspace, imageSettingsReceiptSchema, imageSettingsCommandSchema) },
      request => images.save(workspace.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.get(
      `${modelBase}/images/commands/:requestId`,
      { schema: schema('getImageSettingsCommandV1', modelCommand, imageSettingsReceiptSchema) },
      request => {
        const p = modelCommand.parse(request.params);
        return images.commandStatus(p.workspaceId, user(request), p.requestId);
      },
    );
    routes.get(
      `${modelBase}/commands/:requestId`,
      { schema: schema('getModelPolicyCommandV1', modelCommand, modelPolicyReceiptSchema) },
      request => {
        const p = modelCommand.parse(request.params);
        return models.commandStatus(p.workspaceId, user(request), p.requestId);
      },
    );
    routes.get(
      '/workspaces/:workspaceId/compaction-policy',
      { schema: schema('getCompactionPolicyV1', workspace, compactionPolicySchema) },
      request => compaction.read(workspace.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      '/workspaces/:workspaceId/compaction-policy',
      {
        schema: schema(
          'saveCompactionPolicyV1',
          workspace,
          compactionPolicyReceiptSchema,
          compactionPolicyCommandSchema,
        ),
      },
      request => compaction.save(workspace.parse(request.params).workspaceId, user(request), request.body),
    );
    const page = z.object({
      after: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      search: z.string().trim().max(120).optional(),
    });
    routes.get(
      base,
      { schema: { ...schema('listAgentsV1', workspace, agentListSchema), querystring: json(page) } },
      request => service.list(workspace.parse(request.params).workspaceId, user(request), page.parse(request.query)),
    );
    routes.get(
      `${base}/authoring-context`,
      { schema: schema('getAgentAuthoringContextV1', workspace, agentContextSchema) },
      request => service.context(workspace.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/commands/:commandId`,
      { schema: schema('getAgentCommandV1', workspace.extend({ commandId: z.uuid() }), agentCommandStatusSchema) },
      request => {
        const params = workspace.extend({ commandId: z.uuid() }).parse(request.params);
        return commands.commandStatus(params.workspaceId, user(request), params.commandId);
      },
    );
    routes.get(
      `${base}/:agentId`,
      {
        schema: schema(
          'getAgentV1',
          agent,
          savedAgentSchema.extend({
            definition: agentDefinitionSchema,
            capabilities: z.array(z.string()),
            activations: z.array(z.object({ id: z.uuid(), revision: z.string(), scope: scopeSchema })),
          }),
        ),
      },
      request => {
        const p = agent.parse(request.params);
        return service.detail(p.workspaceId, user(request), p.agentId);
      },
    );
    routes.put(
      `${base}/:agentId`,
      { schema: schema('saveAgentV1', agent, agentCommandStatusSchema, saveAgentSchema) },
      request => {
        const p = agent.parse(request.params);
        return commands.save(p.workspaceId, user(request), p.agentId, request.body);
      },
    );
    routes.delete(
      `${base}/:agentId`,
      { schema: schema('deleteAgentV1', agent, z.object({ deleted: z.boolean() })) },
      request => {
        const p = agent.parse(request.params);
        return service.remove(p.workspaceId, user(request), p.agentId);
      },
    );
    routes.get(
      `${base}/:agentId/policy`,
      {
        schema: schema(
          'getAgentPolicyV1',
          agent,
          agentPolicySchema.extend({
            enrollment: z.array(z.uuid()),
            enabled: z.boolean(),
            limits: scopeSchema,
            taskLimits: taskLimitsSchema.default(maximumTaskLimits),
          }),
        ),
      },
      request => {
        const p = agent.parse(request.params);
        return service.policy(p.workspaceId, user(request), p.agentId);
      },
    );
    routes.put(
      `${base}/:agentId/policy`,
      { schema: schema('setAgentPolicyV1', agent, success, agentPolicySchema) },
      request => {
        const p = agent.parse(request.params);
        return service.updatePolicy(p.workspaceId, user(request), p.agentId, request.body);
      },
    );
    routes.put(
      `${base}/:agentId/enrollment`,
      { schema: schema('configureAgentV1', agent, success, executionPolicySchema) },
      request => {
        const p = agent.parse(request.params);
        return service.configure(p.workspaceId, user(request), p.agentId, request.body);
      },
    );
    const activationParams = agent.extend({ activationId: uuidSchema });
    routes.delete(
      `${base}/:agentId/activations/:activationId`,
      { schema: schema('revokeAgentActivationV1', activationParams, success) },
      request => {
        const p = activationParams.parse(request.params);
        return service.revokeActivation(p.workspaceId, user(request), p.agentId, p.activationId);
      },
    );
    routes.post(
      `${base}/:agentId/activations`,
      {
        schema: schema(
          'activateAgentV1',
          agent,
          z.object({ activationId: z.uuid() }),
          z.strictObject({
            revision: z.string().regex(/^[a-f0-9]{64}$/),
            scope: scopeSchema,
            requestId: uuidSchema.optional(),
          }),
        ),
      },
      request => {
        const p = agent.parse(request.params);
        return service.activate(p.workspaceId, user(request), p.agentId, request.body);
      },
    );
    routes.get(
      `${base}/:agentId/schedules`,
      { schema: schema('listAgentSchedulesV1', agent, z.array(scheduleSchema)) },
      request => {
        const p = agent.parse(request.params);
        return schedules.list(p.workspaceId, user(request), p.agentId);
      },
    );
    routes.put(
      `${base}/:agentId/schedules`,
      { schema: schema('saveAgentScheduleV1', agent, success, scheduleInputSchema) },
      request => {
        const p = agent.parse(request.params);
        return schedules.save(p.workspaceId, user(request), p.agentId, request.body);
      },
    );
    const scheduleParams = agent.extend({ scheduleId: z.uuid() });
    routes.get(
      `${base}/:agentId/chat`,
      { schema: schema('getAgentChatAvailabilityV1', agent, z.object({ configured: z.boolean() })) },
      async request => {
        const p = agent.parse(request.params);
        await service.detail(p.workspaceId, user(request), p.agentId);
        return { configured: chat.configured };
      },
    );
    routes.put(
      `${base}/:agentId/chat`,
      { schema: schema('submitAgentChatV1', agent, chatReceiptSchema, chatInputSchema) },
      request => {
        const p = agent.parse(request.params);
        return chat.submit(p.workspaceId, user(request), p.agentId, request.body);
      },
    );
    const turn = agent.extend({ turnId: z.uuid() });
    routes.get(
      `${base}/:agentId/chat/:turnId`,
      { schema: schema('getAgentChatTurnV1', turn, chatStatusSchema) },
      request => {
        const p = turn.parse(request.params);
        return chat.read(p.workspaceId, user(request), p.agentId, p.turnId);
      },
    );
    routes.post(
      `${base}/:agentId/chat/:turnId/retry`,
      { schema: schema('retryAgentChatV1', turn, retryModelReceiptSchema, retryModelSchema) },
      request => {
        const p = turn.parse(request.params);
        return chat.retry(p.workspaceId, user(request), p.agentId, p.turnId, request.body);
      },
    );
    routes.put(
      `${base}/:agentId/inspection-activation`,
      {
        schema: schema(
          'activateAgentInspectionV1',
          agent,
          z.object({ activationId: z.uuid() }),
          inspectionActivationSchema,
        ),
      },
      request => {
        const p = agent.parse(request.params);
        return schedules.activate(p.workspaceId, user(request), p.agentId, request.body);
      },
    );
    routes.delete(
      `${base}/:agentId/schedules/:scheduleId`,
      { schema: schema('revokeAgentScheduleV1', scheduleParams, success) },
      request => {
        const p = scheduleParams.parse(request.params);
        return schedules.revoke(p.workspaceId, user(request), p.agentId, p.scheduleId);
      },
    );
  });
}
