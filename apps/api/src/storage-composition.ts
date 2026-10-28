import type { FastifyInstance } from 'fastify';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { createWorkspaceTableConfirmation } from '@tulipfarm/workspaces/table-confirmation';
import { registerAgents } from './agents.ts';
import { registerGovernance } from './governance.ts';
import { registerWorkspaceMembers } from './workspace-members.ts';
import { registerWorkspaceSettings } from './workspace-settings.ts';
import { registerSoulExplorer } from './soul-explorer.ts';
import { registerCredits } from './credits.ts';
import { registerRecommendations } from './recommendations.ts';
import { registerRecommendationDispatch } from './recommendation-dispatch.ts';
import { registerRecommendationEvents } from './recommendation-events.ts';
import { recommendationEligibility } from '@tulipfarm/recommendations/configuration';
import { registerTableDispatch } from './table-dispatch.ts';
import { createReplyDispatch, registerConversationDispatch } from './conversation-dispatch.ts';
import { registerIntegrations } from './integrations.ts';
import { integrationCredentialKeyring, createIntegrationService } from '@tulipfarm/integrations';
import type { registerAuth } from './auth.ts';
import type { createTemporalClient } from './temporal.ts';
import { emailDeliveryKeys } from '@tulipfarm/workspaces/email-delivery';
import { authConfig } from './auth.ts';
import { createConversations } from '@tulipfarm/conversations';
import { pinTurnImageModels, recognitionAvailability } from '@tulipfarm/agents/image-settings';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { registerConversations } from './conversations.ts';
import { createConversationEventHub } from './conversation-events.ts';
import { registerProjects } from './projects.ts';
import { registerPersonalMemory } from './personal-memory.ts';
import { registerBud } from './bud.ts';
import { createBudAssistant } from '@tulipfarm/conversations/bud-assistant';
import { createPersonalMemoryService } from '@tulipfarm/conversations/personal-memory';
import { createProjects } from '@tulipfarm/conversations/projects';
import { chatObjectStore } from '@tulipfarm/workspaces/chat-objects';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import { createTableApprovalRequests } from '@tulipfarm/tables/conversation-approvals';
import type { ModelContinuity } from '@tulipfarm/agents/chat';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import { registerWorkflows } from './workflows.ts';
import { registerWorkflowDispatch, workflowWake } from './workflow-dispatch.ts';
import { createWorkflows, workflowCodeStepsEnabled } from '@tulipfarm/workflows';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { resumeOwnerEndedPlans } from '@tulipfarm/agents/plans';
import { registerSkills } from './skills.ts';
import { registerSkillImports } from './skill-imports.ts';
import { registerSkillImportDispatch } from './skill-import-dispatch.ts';
import { registerAgentTasks } from './agent-tasks.ts';
import { planWake, taskActionWake, taskWake } from './task-dispatch.ts';
import { registerAgentPlans } from './agent-plans.ts';
import { createTaskApprovalDecision } from '@tulipfarm/agents/task-approvals';
import { registerAuthoringDrafts } from './authoring-drafts.ts';
import { createAtlassianOperations, trustedOperationBindings } from '@tulipfarm/atlassian/operations';
import { atlassianAccounts } from './atlassian-composition.ts';
import { registerAtlassianOperations } from './atlassian-operations.ts';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { registerGoogleWorkspace } from './google-workspace.ts';
import { googleOperations, googleConfirmation } from './google-composition.ts';
import { registerGoogleOperations } from './google-operations.ts';
import { createGmailHeartbeat } from '@tulipfarm/google-workspace/heartbeat';
import { registerGoogleHeartbeat } from './google-heartbeat.ts';
import { registerGoogleHeartbeatDispatch } from './google-heartbeat-dispatch.ts';
import { registerSlackActions } from './slack-actions.ts';
import { githubAccounts } from './github-composition.ts';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { githubWriteBindings } from '@tulipfarm/github/write-provider';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { chatSkills } from '@tulipfarm/agents/chat-skills';
import { registerGitHubBatches } from './github-batches.ts';
import { registerGitHubTasks } from './github-tasks.ts';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { githubReadBindings } from '@tulipfarm/github/read-provider';
import { registerTableChanges } from './table-changes.ts';
import { registerTableQueryTranslations } from './table-query-translations.ts';
import { tableProposalOptions } from '@tulipfarm/agents/table-proposals';
import { registerFilesComposition } from './files-composition.ts';
import { registerFilesGoogleCopy } from './files-google-copy.ts';
import { registerKnowledgeComposition } from './knowledge-composition.ts';
import { registerKnowledgeDispatch } from './knowledge-dispatch.ts';
import type { defaultKnowledgeStarter } from './knowledge-defaults-dispatch.ts';
import { workspaceMcpApi } from './workspace-mcp-composition.ts';
import { registerWorkspaceMcp } from './workspace-mcp.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { AgentSetupOptions } from '@tulipfarm/agents/setup';
import { registerAgentAuthoringAssistance } from './agent-authoring-assistance.ts';
import { registerSystemPackages } from './system-packages.ts';
import { configuredSkillRuntimeProbe } from '@tulipfarm/workflow-snippets/client';

export function registerStorageComposition(
  app: FastifyInstance,
  dependencies: ReturnType<typeof registerAuth>,
  temporal: ReturnType<typeof createTemporalClient>,
  runtime: WorkspaceRuntime | undefined,
  agentModel?: ModelContinuity | null,
  modelFamilyEligibility?: ModelFamilyEligibility,
  agentSetup?: AgentSetupOptions,
  defaultKnowledge?: ReturnType<typeof defaultKnowledgeStarter>,
) {
  if (!runtime) {
    registerWorkspaceMcp(app, dependencies.auth, null);
    return;
  }
  registerCredits(app, { runtime, auth: dependencies.auth });
  registerRecommendations(app, { runtime, auth: dependencies.auth });
  registerRecommendationDispatch(app, { pool: dependencies.pool, runtime, temporal });
  registerPersonalMemory(app, { auth: dependencies.auth, service: createPersonalMemoryService(runtime) });
  registerBud(app, { auth: dependencies.auth, service: createBudAssistant(runtime) });
  registerSkills(app, { runtime, auth: dependencies.auth });
  const wake = workflowWake(app, temporal);
  const wakeTask = taskWake(app, temporal);
  const wakeTaskAction = taskActionWake(app, runtime, wakeTask, wake);
  registerAuthoringDrafts(app, { runtime, auth: dependencies.auth, modelFamilyEligibility, wake, agentSetup });
  registerAgentAuthoringAssistance(app, {
    runtime,
    auth: dependencies.auth,
    modelFamilyEligibility: modelFamilyEligibility ?? (() => false),
  });
  registerWorkspaceSettings(app, { auth: dependencies.auth, pool: dependencies.pool, runtime });
  registerSoulExplorer(app, { auth: dependencies.auth, pool: dependencies.pool, runtime });
  const workflows = createWorkflows(runtime, {
    keyring: integrationCredentialKeyring(),
    codeSteps: workflowCodeStepsEnabled(),
    agentSteps: true,
    agentResultReadable: createAgentTasks(runtime).resultReadable,
    wake,
  });
  registerWorkflows(app, { auth: dependencies.auth, service: workflows, identity: dependencies.pool });
  registerWorkflowDispatch(app, { pool: dependencies.pool, service: workflows, temporal });
  const chatObjects = chatObjectStore();
  if (chatObjects) {
    registerSkillImports(app, { runtime, auth: dependencies.auth, objects: chatObjects });
    registerSkillImportDispatch(app, { runtime, pool: dependencies.pool, temporal, objects: chatObjects });
  }
  const files = chatObjects
    ? registerFilesComposition(app, {
        runtime,
        auth: dependencies.auth,
        objects: chatObjects,
        identity: dependencies.pool,
      })
    : undefined;
  const googleService = createGoogleWorkspaceService({
    runtime,
    keyring: integrationCredentialKeyring(),
    ...(defaultKnowledge ? { defaultKnowledge: defaultKnowledge.hook } : {}),
  });
  const knowledge = registerKnowledgeComposition(app, {
    runtime,
    auth: dependencies.auth,
    pool: dependencies.pool,
    temporal,
    googleService,
    // Recognition runs in the worker; the API only needs to know a model can read images to queue re-parses.
    recognitionAvailable: recognitionAvailability(runtime),
    ...(files ? { files } : {}),
    ...(defaultKnowledge ? { defaultKnowledge } : {}),
  });
  registerKnowledgeDispatch(app, { pool: dependencies.pool, service: knowledge, temporal });
  const attachments = chatObjects ? createAttachments(runtime, chatObjects, files ? { files } : {}) : undefined;
  app.addHook('onClose', async () => {
    chatObjects?.close();
  });
  for (const key of [
    'WORKSPACE_PROVISIONING_DATABASE_URL',
    'WORKSPACE_MIGRATION_KEY',
    'WORKSPACE_MIGRATION_PREVIOUS_KEYS',
    'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
    'WORKSPACE_AUTHORING_DATABASE_URL',
  ]) {
    if (process.env[key]) throw new Error('API must not receive authoring or maintenance credentials');
  }
  const confirmation = createWorkspaceTableConfirmation(runtime);
  registerSystemPackages(app, {
    runtime,
    identity: dependencies.pool,
    auth: dependencies.auth,
    pool: dependencies.pool,
    objects: chatObjects ?? undefined,
    resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
    modelFamilyEligibility,
    agentSetup,
    workflows: {
      keyring: integrationCredentialKeyring(),
      codeSteps: workflowCodeStepsEnabled(),
      agentSteps: true,
    },
    skillRuntimeAvailable: configuredSkillRuntimeProbe(),
  });
  const mcp = workspaceMcpApi(app, runtime, confirmation.resolveConfirmationCredential);
  registerWorkspaceMcp(app, dependencies.auth, mcp, wakeTaskAction);
  const github = githubAccounts(runtime);
  if (github) {
    const batchOptions = {
      runtime,
      accounts: github,
      requireSources: requireDraftSources,
      bindings: githubWriteBindings(),
    };
    registerGitHubBatches(app, {
      auth: dependencies.auth,
      batches: createGitHubBatches(batchOptions),
      decide: createGitHubBatchDecision({
        ...batchOptions,
        resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
      }),
    });
    registerGitHubTasks(app, {
      auth: dependencies.auth,
      reads: createGitHubReads({ runtime, accounts: github, bindings: githubReadBindings() }),
      batches: createGitHubBatches(batchOptions),
      decide: createGitHubBatchDecision({
        ...batchOptions,
        resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
      }),
      wake: wakeTask,
    });
  }
  registerTableChanges(app, {
    ...tableProposalOptions(runtime, chatObjects ? { attachments: chatObjects, snapshots: chatObjects } : undefined),
    auth: dependencies.auth,
    resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
  });
  registerTableQueryTranslations(app, { runtime, auth: dependencies.auth });
  registerSlackActions(app, {
    runtime,
    auth: dependencies.auth,
    resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
    wakeTaskAction,
  });
  registerAgentPlans(app, { runtime, auth: dependencies.auth, wake: planWake(app, temporal) });
  registerAgentTasks(app, {
    runtime,
    auth: dependencies.auth,
    attachments,
    decide: createTaskApprovalDecision({
      runtime,
      resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
    }),
    claimMcpSelection: mcp.claimTaskSelection,
    wake: wakeTask,
  });
  const accounts = atlassianAccounts(runtime);
  registerAtlassianOperations(
    app,
    dependencies.auth,
    accounts ? createAtlassianOperations({ runtime, accounts, bindings: trustedOperationBindings() }) : null,
    confirmation.atlassian,
  );
  const approvalRequests = createTableApprovalRequests(runtime);
  // One held auth-pool client per replica keeps the modeled API connection budget unchanged (infra/storage-release/gate.py).
  const events = createConversationEventHub({
    connect: () => dependencies.pool.connect(),
    log: message => app.log.warn(message),
  });
  registerRecommendationEvents(app, {
    runtime,
    auth: dependencies.auth,
    events,
    eligible: recommendationEligibility(dependencies.pool),
  });
  app.addHook('preClose', async () => {
    events.close();
  });
  const replies = createReplyDispatch({ runtime, temporal });
  registerConversations(app, {
    auth: dependencies.auth,
    service: createConversations(runtime, chatSkills, {
      pinTurn: async (tx, workspaceId, familyId) =>
        (await isFeatureEnabled('images', null, { id: workspaceId })) ? pinTurnImageModels(tx, familyId) : null,
      retryTurn: resumeOwnerEndedPlans,
    }),
    requests: createConversationRequests(runtime),
    approvals: { read: approvalRequests.read, decide: confirmation.approvals.decide },
    attachments,
    identity: dependencies.pool,
    events,
    replies,
  });
  registerProjects(app, {
    auth: dependencies.auth,
    identity: dependencies.pool,
    service: createProjects(runtime, attachments, files),
  });
  registerAgents(app, {
    auth: dependencies.auth,
    pool: dependencies.pool,
    runtime,
    agentModel,
    modelFamilyEligibility,
    agentSetup,
  });
  app.addHook('onClose', async () => {
    await confirmation.close();
  });
  registerGovernance(app, {
    auth: dependencies.auth,
    identity: dependencies.pool,
    runtime,
    compatibility: commonCompatibility,
    emailDelivery: { keys: emailDeliveryKeys(), webOrigin: authConfig().webOrigin },
    acceptUnverifiedEmail: authConfig().emailPassword,
  });
  registerWorkspaceMembers(app, { auth: dependencies.auth, runtime });
  registerIntegrations(app, {
    auth: dependencies.auth,
    service: createIntegrationService({ runtime, keyring: integrationCredentialKeyring() }),
  });
  registerGoogleWorkspace(app, { auth: dependencies.auth, service: googleService });
  const gmail = createGmailHeartbeat({ runtime, integrations: googleService });
  registerGoogleHeartbeat(app, { auth: dependencies.auth, service: gmail });
  registerGoogleHeartbeatDispatch(app, { pool: dependencies.pool, service: gmail, temporal });
  const googleApproval = googleConfirmation(runtime);
  app.addHook('onClose', async () => {
    await googleApproval.close();
  });
  const google = googleOperations(runtime);
  registerGoogleOperations(app, {
    auth: dependencies.auth,
    runtime,
    operations: google,
    approve: googleApproval.approve,
  });
  if (files) registerFilesGoogleCopy(app, { auth: dependencies.auth, files, google });
  registerTableDispatch(app, { pool: dependencies.pool, runtime, temporal, wakeTask });
  registerConversationDispatch(app, {
    pool: dependencies.pool,
    runtime,
    temporal,
    attachments,
    replies,
    expireApprovals: async workspaceId => {
      for (const requestId of await approvalRequests.due(workspaceId))
        await confirmation.approvals.expire(workspaceId, requestId);
    },
  });
}
