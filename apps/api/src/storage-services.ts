import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { createWorkspaceTableConfirmation } from '@tulipfarm/workspaces/table-confirmation';
import { chatObjectStore } from '@tulipfarm/workspaces/chat-objects';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createConversations } from '@tulipfarm/conversations';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import { pinTurnImageModels, recognitionAvailability } from '@tulipfarm/agents/image-settings';
import type { ModelContinuity } from '@tulipfarm/agents/chat';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import type { AgentSetupOptions } from '@tulipfarm/agents/setup';
import { chatSkills } from '@tulipfarm/agents/chat-skills';
import { createFollowUps } from '@tulipfarm/agents/follow-ups';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { resumeOwnerEndedPlans } from '@tulipfarm/agents/plans';
import { createSystemPackages } from '@tulipfarm/agents/system-packages';
import { createTableApprovalRequests } from '@tulipfarm/tables/conversation-approvals';
import { createWorkflows, workflowCodeStepsEnabled } from '@tulipfarm/workflows';
import { createGitHubSubscriptions } from '@tulipfarm/workflows/github-triggers';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGmailHeartbeat } from '@tulipfarm/google-workspace/heartbeat';
import { configuredSkillRuntimeProbe } from '@tulipfarm/workflow-snippets/client';
import { isFeatureEnabled } from '@tulipfarm/observability';
import type { createTemporalClient } from './temporal.ts';
import { createAgentWork, registerAgentSweeps } from './agent-sweeps.ts';
import { createFilesService } from './files-service.ts';
import { createKnowledgeServices, registerKnowledgeSweeps } from './knowledge-services.ts';
import type { defaultKnowledgeStarter } from './knowledge-defaults-dispatch.ts';
import { registerKnowledgeDispatch } from './knowledge-dispatch.ts';
import { registerRecommendationDispatch } from './recommendation-dispatch.ts';
import { registerWorkflowDispatch, workflowWake } from './workflow-dispatch.ts';
import { registerSkillImportDispatch } from './skill-import-dispatch.ts';
import { registerSystemPackageSweep } from './system-package-sweep.ts';
import { registerGoogleHeartbeatDispatch } from './google-heartbeat-dispatch.ts';
import { registerTableDispatch } from './table-dispatch.ts';
import { createReplyDispatch, registerConversationDispatch } from './conversation-dispatch.ts';

export type StorageServiceDependencies = {
  pool: Pool;
  temporal: ReturnType<typeof createTemporalClient>;
  runtime: WorkspaceRuntime;
  agentModel?: ModelContinuity | null | undefined;
  modelFamilyEligibility?: ModelFamilyEligibility | undefined;
  agentSetup?: AgentSetupOptions | undefined;
  defaultKnowledge?: ReturnType<typeof defaultKnowledgeStarter> | undefined;
};

export type StorageServices = ReturnType<typeof createStorageServices>;

/**
 * The workspace services that both the request routes and the background sweeps use. The `jobs` role builds only
 * these and the sweeps, so it never loads or compiles the request routes.
 */
export function createStorageServices(app: FastifyInstance, dependencies: StorageServiceDependencies) {
  const { pool, temporal, runtime, modelFamilyEligibility, defaultKnowledge } = dependencies;
  for (const key of [
    'WORKSPACE_PROVISIONING_DATABASE_URL',
    'WORKSPACE_MIGRATION_KEY',
    'WORKSPACE_MIGRATION_PREVIOUS_KEYS',
    'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
    'WORKSPACE_AUTHORING_DATABASE_URL',
  ]) {
    if (process.env[key]) throw new Error('API must not receive authoring or maintenance credentials');
  }
  const wake = workflowWake(app, temporal);
  const githubSubscriptions = createGitHubSubscriptions(pool);
  const agentSetup: AgentSetupOptions = { ...dependencies.agentSetup, workflowWake: wake, githubSubscriptions };
  const chatObjects = chatObjectStore();
  app.addHook('onClose', async () => {
    chatObjects?.close();
  });
  const workflows = createWorkflows(runtime, {
    keyring: integrationCredentialKeyring(),
    codeSteps: workflowCodeStepsEnabled(),
    codingSteps: workflowCodeStepsEnabled(),
    agentSteps: true,
    agentResultReadable: createAgentTasks(runtime).resultReadable,
    wake,
    githubSubscriptions,
  });
  const files = chatObjects ? createFilesService(app.log, { runtime, objects: chatObjects }) : undefined;
  const googleService = createGoogleWorkspaceService({
    runtime,
    keyring: integrationCredentialKeyring(),
    ...(defaultKnowledge ? { defaultKnowledge: defaultKnowledge.hook } : {}),
  });
  const knowledge = createKnowledgeServices({
    runtime,
    pool,
    googleService,
    // Recognition runs in the worker; the API only needs to know a model can read images to queue re-parses.
    recognitionAvailable: recognitionAvailability(runtime),
    ...(files ? { files } : {}),
    ...(defaultKnowledge ? { defaultKnowledge } : {}),
  });
  const attachments = chatObjects ? createAttachments(runtime, chatObjects, files ? { files } : {}) : undefined;
  const confirmation = createWorkspaceTableConfirmation(runtime);
  app.addHook('onClose', async () => {
    await confirmation.close();
  });
  const systemPackages = createSystemPackages({
    runtime,
    identity: pool,
    objects: chatObjects ?? undefined,
    resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
    modelFamilyEligibility,
    agentSetup,
    workflows: {
      keyring: integrationCredentialKeyring(),
      codeSteps: workflowCodeStepsEnabled(),
      codingSteps: workflowCodeStepsEnabled(),
      agentSteps: true,
    },
    skillRuntimeAvailable: configuredSkillRuntimeProbe(),
  });
  const conversations = createConversations(runtime, chatSkills, {
    pinTurn: async (tx, workspaceId, familyId) =>
      (await isFeatureEnabled('images', null, { id: workspaceId })) ? pinTurnImageModels(tx, familyId) : null,
    retryTurn: resumeOwnerEndedPlans,
  });
  return {
    wake,
    githubSubscriptions,
    agentSetup,
    chatObjects,
    workflows,
    files,
    googleService,
    knowledge,
    attachments,
    confirmation,
    systemPackages,
    agents: createAgentWork({
      runtime,
      agentModel: dependencies.agentModel,
      modelFamilyEligibility,
      agentSetup,
    }),
    approvalRequests: createTableApprovalRequests(runtime),
    replies: createReplyDispatch({ runtime, temporal }),
    conversations,
    followUps: createFollowUps(runtime),
    gmail: createGmailHeartbeat({ runtime, integrations: googleService }),
  };
}

/** Starts the scheduled sweeps. They run only in the `all` and `jobs` roles; see `backgroundSweeps`. */
export function registerStorageSweeps(
  app: FastifyInstance,
  dependencies: StorageServiceDependencies,
  services: StorageServices,
) {
  const { pool, temporal, runtime } = dependencies;
  registerRecommendationDispatch(app, { pool, runtime, temporal });
  registerWorkflowDispatch(app, { pool, service: services.workflows, temporal });
  if (services.chatObjects)
    registerSkillImportDispatch(app, { runtime, pool, temporal, objects: services.chatObjects });
  registerKnowledgeSweeps(app, { pool, temporal }, services.knowledge);
  registerKnowledgeDispatch(app, { pool, service: services.knowledge.service, temporal });
  registerSystemPackageSweep(app, pool, services.systemPackages);
  registerAgentSweeps(app, pool, services.agents);
  registerGoogleHeartbeatDispatch(app, { pool, service: services.gmail, temporal });
  registerTableDispatch(app, { pool, runtime, temporal, agentWorkflows: services.agentSetup });
  registerConversationDispatch(app, {
    pool,
    runtime,
    temporal,
    attachments: services.attachments,
    replies: services.replies,
    fireFollowUps: workspaceId => services.followUps.due(workspaceId, services.conversations.send),
    expireApprovals: async workspaceId => {
      for (const requestId of await services.approvalRequests.due(workspaceId))
        await services.confirmation.approvals.expire(workspaceId, requestId);
    },
  });
}
