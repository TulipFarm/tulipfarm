import type { FastifyInstance } from 'fastify';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { registerAgents } from './agents.ts';
import { registerAppPages } from './app-pages.ts';
import { registerGovernance } from './governance.ts';
import { registerWorkspaceMembers } from './workspace-members.ts';
import { registerActors } from './actors.ts';
import { registerRowWork } from './row-work.ts';
import { registerWorkspaceSettings } from './workspace-settings.ts';
import { registerSoulExplorer } from './soul-explorer.ts';
import { registerCredits } from './credits.ts';
import { registerRecommendations } from './recommendations.ts';
import { registerRecommendationEvents } from './recommendation-events.ts';
import { recommendationEligibility } from '@tulipfarm/recommendations/configuration';
import { createApiCallReviews, registerApiCalls } from './api-calls.ts';
import { createCodingRunReviews, registerCodingRuns } from './coding-runs.ts';
import { registerIntegrations } from './integrations.ts';
import { integrationCredentialKeyring, createIntegrationService } from '@tulipfarm/integrations';
import type { registerAuth } from './auth.ts';
import type { createTemporalClient } from './temporal.ts';
import { emailDeliveryKeys } from '@tulipfarm/workspaces/email-delivery';
import { authConfig } from './auth.ts';
import { registerConversations } from './conversations.ts';
import { registerFollowUps } from './follow-ups.ts';
import { registerLayoutInteractions } from './layout-interactions.ts';
import { humanReadableTableFiles } from '@tulipfarm/agents/table-sources';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { createTableService } from '@tulipfarm/tables/service';
import { createConversationEventHub } from './conversation-events.ts';
import { registerProjects } from './projects.ts';
import { registerPersonalMemory } from './personal-memory.ts';
import { keepConfiguration } from '@tulipfarm/config/keep';
import { registerBud } from './bud.ts';
import { createBudAssistant } from '@tulipfarm/conversations/bud-assistant';
import { createPersonalMemoryService } from '@tulipfarm/conversations/personal-memory';
import { createProjects } from '@tulipfarm/conversations/projects';
import { createChatExecution } from '@tulipfarm/conversations/execution';
import { registerExecutionFiles } from './execution-files.ts';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import type { ModelContinuity } from '@tulipfarm/agents/chat';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import { registerWorkflows } from './workflows.ts';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { registerSkills } from './skills.ts';
import { registerSkillImports } from './skill-imports.ts';
import { registerAgentTasks } from './agent-tasks.ts';
import { planDocumentStart, planWake, taskActionWake, taskWake } from './task-dispatch.ts';
import { registerAgentPlans } from './agent-plans.ts';
import { createTaskApprovalDecision } from '@tulipfarm/agents/task-approvals';
import { registerAuthoringDrafts } from './authoring-drafts.ts';
import { createAtlassianOperations, trustedOperationBindings } from '@tulipfarm/atlassian/operations';
import { atlassianAccounts } from './atlassian-composition.ts';
import { registerAtlassianOperations } from './atlassian-operations.ts';
import { registerGoogleWorkspace } from './google-workspace.ts';
import { googleOperations, googleConfirmation } from './google-composition.ts';
import { registerGoogleOperations } from './google-operations.ts';
import { registerGoogleHeartbeat } from './google-heartbeat.ts';
import { registerSlackActions } from './slack-actions.ts';
import { githubAccounts } from './github-composition.ts';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { githubWriteBindings } from '@tulipfarm/github/write-provider';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { registerGitHubBatches } from './github-batches.ts';
import { registerGitHubTasks } from './github-tasks.ts';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { githubReadBindings } from '@tulipfarm/github/read-provider';
import { registerTableChanges } from './table-changes.ts';
import { registerTableQueryTranslations } from './table-query-translations.ts';
import { tableProposalOptions } from '@tulipfarm/agents/table-proposals';
import { registerFilesGoogleCopy } from './files-google-copy.ts';
import type { defaultKnowledgeStarter } from './knowledge-defaults-dispatch.ts';
import { workspaceMcpApi } from './workspace-mcp-composition.ts';
import { registerSecrets } from './secrets.ts';
import { secretsServices } from './secrets-composition.ts';
import { registerWorkspaceMcp } from './workspace-mcp.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { AgentSetupOptions } from '@tulipfarm/agents/setup';
import { registerAgentAuthoringAssistance } from './agent-authoring-assistance.ts';
import { registerSystemPackages } from './system-packages.ts';
import { createGitHubWorkflowFanOut } from '@tulipfarm/workflows/github-triggers';
import { registerFiles } from './files.ts';
import { registerKnowledgeRoutes } from './knowledge-composition.ts';
import { createStorageServices, registerStorageSweeps } from './storage-services.ts';
import { createAgentEvals, registerAgentEvals } from './agent-evals.ts';

export function registerStorageComposition(
  app: FastifyInstance,
  dependencies: ReturnType<typeof registerAuth>,
  temporal: ReturnType<typeof createTemporalClient>,
  runtime: WorkspaceRuntime | undefined,
  agentModel?: ModelContinuity | null,
  modelFamilyEligibility?: ModelFamilyEligibility,
  configuredAgentSetup?: AgentSetupOptions,
  defaultKnowledge?: ReturnType<typeof defaultKnowledgeStarter>,
) {
  if (!runtime) {
    registerWorkspaceMcp(app, dependencies.auth, null);
    return;
  }
  const sweepDependencies = {
    pool: dependencies.pool,
    temporal,
    runtime,
    agentModel,
    modelFamilyEligibility,
    agentSetup: configuredAgentSetup,
    defaultKnowledge,
  };
  const services = createStorageServices(app, sweepDependencies);
  registerStorageSweeps(app, sweepDependencies, services);
  const { wake, githubSubscriptions, agentSetup, chatObjects, workflows, files, googleService, attachments } = services;
  const { confirmation, approvalRequests, replies, conversations, followUps, gmail } = services;
  registerCredits(app, { runtime, auth: dependencies.auth });
  registerRecommendations(app, { runtime, auth: dependencies.auth });
  // Keep is reached lazily per workspace; an invalid endpoint still fails at startup.
  keepConfiguration();
  registerPersonalMemory(app, { auth: dependencies.auth, service: createPersonalMemoryService(runtime) });
  registerBud(app, { auth: dependencies.auth, service: createBudAssistant(runtime) });
  registerSkills(app, { runtime, auth: dependencies.auth });
  const wakeTask = taskWake(app, temporal);
  const wakeTaskAction = taskActionWake(app, runtime, wakeTask, wake);
  registerExecutionFiles(app, {
    auth: dependencies.auth,
    service: createChatExecution(runtime, { mode: 'off' }, undefined, chatObjects ?? undefined),
  });
  registerAuthoringDrafts(app, {
    runtime,
    auth: dependencies.auth,
    modelFamilyEligibility,
    wake,
    agentSetup,
    githubSubscriptions,
    ...(chatObjects ? { fileBytes: chatObjects } : {}),
  });
  registerAgentAuthoringAssistance(app, {
    runtime,
    auth: dependencies.auth,
    modelFamilyEligibility: modelFamilyEligibility ?? (() => false),
  });
  registerWorkspaceSettings(app, { auth: dependencies.auth, pool: dependencies.pool, runtime });
  registerSoulExplorer(app, { auth: dependencies.auth, pool: dependencies.pool, runtime });
  registerWorkflows(app, { auth: dependencies.auth, service: workflows, identity: dependencies.pool });
  if (chatObjects) registerSkillImports(app, { runtime, auth: dependencies.auth, objects: chatObjects });
  if (files) registerFiles(app, { auth: dependencies.auth, service: files, identity: dependencies.pool });
  registerKnowledgeRoutes(
    app,
    {
      runtime,
      auth: dependencies.auth,
      pool: dependencies.pool,
      githubWorkflowFanOut: createGitHubWorkflowFanOut(dependencies.pool, runtime),
      ...(defaultKnowledge ? { defaultKnowledge } : {}),
    },
    services.knowledge,
  );
  registerSystemPackages(app, { auth: dependencies.auth, service: services.systemPackages });
  const mcp = workspaceMcpApi(app, runtime, confirmation.resolveConfirmationCredential, temporal, dependencies.pool);
  registerWorkspaceMcp(app, dependencies.auth, mcp, wakeTaskAction);
  registerSecrets(app, dependencies.auth, secretsServices(runtime), wakeTask);
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
    identity: dependencies.pool,
  });
  registerTableQueryTranslations(app, { runtime, auth: dependencies.auth });
  registerSlackActions(app, {
    runtime,
    auth: dependencies.auth,
    pool: dependencies.pool,
    resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
    wakeTaskAction,
  });
  registerAgentPlans(app, {
    runtime,
    auth: dependencies.auth,
    wake: planWake(app, temporal),
    identity: dependencies.pool,
    ...(chatObjects ? { documents: { objects: chatObjects, start: planDocumentStart(app, temporal) } } : {}),
  });
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
  registerApiCalls(
    app,
    dependencies.auth,
    createApiCallReviews({
      runtime,
      resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
      wakeChat: replies.sent,
      wakeTask,
    }),
  );
  registerCodingRuns(
    app,
    dependencies.auth,
    createCodingRunReviews({
      runtime,
      resolveConfirmationCredential: confirmation.resolveConfirmationCredential,
      wakeChat: replies.sent,
    }),
  );
  registerFollowUps(app, { auth: dependencies.auth, followUps });
  registerConversations(app, {
    auth: dependencies.auth,
    service: conversations,
    requests: createConversationRequests(runtime),
    approvals: { read: approvalRequests.read, decide: confirmation.approvals.decide },
    attachments,
    identity: dependencies.pool,
    events,
    replies,
  });
  registerLayoutInteractions(app, {
    auth: dependencies.auth,
    service: conversations,
    tables: createTableService(runtime, { readableFiles: humanReadableTableFiles }, executionCompatibility),
    replies,
  });
  const appAgentTasks = createAgentTasks(runtime);
  registerAppPages(app, {
    auth: dependencies.auth,
    runtime,
    tables: createTableService(runtime, { readableFiles: humanReadableTableFiles }, executionCompatibility),
    startWorkflow: workflows.start,
    askAgent: async (workspaceId, userId, input) => {
      const task = await appAgentTasks.start(workspaceId, userId, input);
      await wakeTask(workspaceId, task.id);
      return { taskId: task.id };
    },
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
    modelFamilyEligibility,
    work: services.agents,
  });
  registerAgentEvals(app, {
    auth: dependencies.auth,
    evals: createAgentEvals(runtime, modelFamilyEligibility),
    temporal,
  });
  dependencies.invitationLinks.current = registerGovernance(app, {
    auth: dependencies.auth,
    identity: dependencies.pool,
    runtime,
    compatibility: commonCompatibility,
    emailDelivery: { keys: emailDeliveryKeys(), webOrigin: authConfig().webOrigin },
    acceptUnverifiedEmail: authConfig().emailPassword,
  });
  registerWorkspaceMembers(app, { auth: dependencies.auth, runtime });
  registerActors(app, { auth: dependencies.auth, runtime });
  registerRowWork(app, { auth: dependencies.auth, runtime });
  registerIntegrations(app, {
    auth: dependencies.auth,
    service: createIntegrationService({ runtime, keyring: integrationCredentialKeyring() }),
  });
  registerGoogleWorkspace(app, { auth: dependencies.auth, service: googleService });
  registerGoogleHeartbeat(app, { auth: dependencies.auth, service: gmail });
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
}
