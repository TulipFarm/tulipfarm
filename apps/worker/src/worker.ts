import '@tulipfarm/config/load-secret-files';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import { publicWebConfiguration } from '@tulipfarm/config/public-web';
import { apiCallPrivateHosts } from '@tulipfarm/api-calls';
import { appBuilders } from '@tulipfarm/apps';
import { executionConfiguration } from '@tulipfarm/config/execution';
import type { ExecutionBackend, ExecutionConfiguration } from '@tulipfarm/execution-contract';
import {
  captureException,
  createBackgroundJob,
  errorAttributes,
  log,
  observeTemporalSlots,
  registerFlagSubjectResolver,
  startTelemetry,
} from '@tulipfarm/observability';
import {
  appBuilder,
  appHost,
  configuredExecutionBackend,
  shutdownExtensions,
  startExtensions,
} from '@tulipfarm/extensions';
import { temporalSlotReadings, workerTelemetry } from './telemetry.ts';
import { loadModelCatalog } from '@tulipfarm/config';
import { readBuildInfo } from '@tulipfarm/build-info/node';
import * as activities from './activities.ts';
import { isolatedStorageEnabled } from '@tulipfarm/workspaces/storage';
import { createTableAuthoringComposition } from './table-authoring-composition.ts';
import { createAgentComposition } from './agent-composition.ts';
import { createEmailDeliveryComposition, emailDeliveryEnabled } from './email-delivery-composition.ts';
import { createConversationActivities } from './conversation-activities.ts';
import { createConversationMaintenanceActivities } from './conversation-maintenance-activities.ts';
import { createGoogleHeartbeatActivities } from './google-heartbeat-activities.ts';
import { createWorkflows } from '@tulipfarm/workflows';
import type { SnippetClient } from '@tulipfarm/workflow-snippets/protocol';
import { createExecutionSnippetClient } from './workflow-code-steps.ts';
import { createTaskComposition } from './task-composition.ts';
import { createModelBundleRegistry } from './model-bundle-registry.ts';
import { createTaskDispatcher, createTaskRecovery } from './task-dispatch.ts';
import { createPlanComposition, createPlanDispatcher } from './plan-composition.ts';
import { createPlanDocumentComposition, createPlanDocumentDispatcher } from './plan-document-composition.ts';
import { createKnowledgeTools } from './knowledge-tools-composition.ts';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { evaluateWorkflowDecision } from '@tulipfarm/agents/decisions';
import { createSlackPromptComposition } from './slack-composition.ts';
import { chatObjectStore } from '@tulipfarm/workspaces/chat-objects';
import { createObjectCleanupSweep, createTableSearchSweep } from './table-cleanup.ts';
import { githubRuntimeConfiguration } from '@tulipfarm/github/configuration';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createKnowledgeActivities } from './knowledge-activities.ts';
import { knowledgeMediaRecognition } from './media-recognition.ts';
import { createFiles } from '@tulipfarm/files';
import { createKnowledgeKeepParts } from './knowledge-keep-composition.ts';
import { createGoogleKnowledgeParts } from './knowledge-google-composition.ts';
import { createSlackKnowledgeParts } from './knowledge-slack-composition.ts';
import { createGitHubKnowledgeParts } from './knowledge-github-composition.ts';
import { createAtlassianKnowledgeParts } from './knowledge-atlassian-composition.ts';
import { createDefaultKnowledgeParts } from './knowledge-defaults-composition.ts';
import { createKnowledgeWorker } from './knowledge-worker.ts';
import { workflowSource } from './workflow-source.ts';
import { withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import { createWorkflowAgentTasks } from './workflow-agent-tasks.ts';
import { createSkillActivities } from './skill-activities.ts';
import { createEvalActivities } from './eval-activities.ts';
import { createWorkspaceMcpDiscoveryActivities, createWorkspaceMcpHostedSweep } from './workspace-mcp-composition.ts';
import { configuredSkillClient } from '@tulipfarm/workflow-snippets/client';
import { createSkillExecutionFactory } from '@tulipfarm/agents/skill-execution';
import { createChatExecution, type ChatExecution } from '@tulipfarm/agents/chat-execution';
import { codingRunsFactory, createCodingRunActivities, createCodingRunDispatcher } from './coding-runs.ts';
import { createCodeSessionActivities } from './code-sessions.ts';
import { createWorkflowCodingActivities, createWorkflowCodingDispatcher } from './workflow-coding-steps.ts';
import { slackActionsFromEnvironment } from '@tulipfarm/agents/slack-environment';
import { createRecommendationComposition } from './recommendation-activities.ts';
import { createRowAssignmentComposition } from './row-assignment-composition.ts';
import { createMemberProfileComposition } from './member-profile-composition.ts';
import { createAgentLessonComposition } from './agent-lesson-composition.ts';
import { createSocialPublisherComposition } from './social-publisher-composition.ts';
import { createSecretsSweep } from './secrets-sweep.ts';
import { createAppComposition, repeatFromStart } from './app-composition.ts';
import { createResourceBilling } from './resource-billing.ts';
import { createCreditAlerts } from './credit-alerts.ts';
import { appEditingFromEnvironment, createAppBuildDispatcher } from './app-editing-composition.ts';
import { workerRole, workerTelemetryService } from './worker-role.ts';
import { workspaceSchemaPending } from '@tulipfarm/workspace-storage/runtime';

const role = workerRole();
const service = workerTelemetryService(role);
// Bare package names in TULIPFARM_EXTENSIONS resolve from this app.
await startExtensions('worker', { resolve: specifier => import.meta.resolve(specifier), service });
let chatExecution: ChatExecution | undefined;
let coding: { backend: ExecutionBackend; configuration: Exclude<ExecutionConfiguration, { mode: 'off' }> } | undefined;
let snippets: SnippetClient | undefined;
if (role !== 'knowledge') {
  try {
    const configuration = executionConfiguration();
    const backend = configuredExecutionBackend(configuration);
    if (backend && configuration.mode !== 'off') {
      chatExecution = createChatExecution(backend, configuration);
      coding = { backend, configuration };
      snippets = createExecutionSnippetClient(backend, configuration);
    }
  } catch (error) {
    await shutdownExtensions();
    throw error;
  }
}
const telemetry = startTelemetry(readBuildInfo('worker', new URL('../version.json', import.meta.url)), {
  serviceName: service,
});

async function run() {
  const github = githubRuntimeConfiguration();
  if (github.oauth) {
    if (!isolatedStorageEnabled()) throw new Error('GitHub requires isolated workspace storage');
    integrationCredentialKeyring();
  }
  // Fails startup on an invalid model catalog or provider environment.
  for (const warning of loadModelCatalog().warnings) console.warn(JSON.stringify({ level: 'warn', msg: warning }));
  // Fails startup on removed Firecrawl settings, an invalid public web endpoint or private host list.
  publicWebConfiguration();
  apiCallPrivateHosts();
  const emailEnabled = emailDeliveryEnabled();
  for (const key of [
    'WORKSPACE_PROVISIONING_DATABASE_URL',
    'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
    'WORKSPACE_MIGRATION_KEY',
    'WORKSPACE_CONFIRMATION_KEY',
    'WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL',
    'WORKSPACE_MIGRATION_PREVIOUS_KEYS',
    'WORKSPACE_CONFIRMATION_PREVIOUS_KEYS',
  ]) {
    if (process.env[key]) throw new Error('Ordinary workers must not receive storage maintenance credentials');
  }
  const connection = await NativeConnection.connect(temporalConnectionOptions());
  let resources: ReturnType<typeof createTableAuthoringComposition> | undefined;
  let email: Awaited<ReturnType<typeof createEmailDeliveryComposition>> | undefined;
  let tasks: ReturnType<typeof createTaskComposition> | undefined;
  let modelBundles: ReturnType<typeof createModelBundleRegistry> | undefined;
  let taskDispatch: ReturnType<typeof createTaskDispatcher> | undefined;
  let codingDispatch: ReturnType<typeof createCodingRunDispatcher> | undefined;
  let workflowCoding: ReturnType<typeof createWorkflowCodingDispatcher> | undefined;
  let appBuilds: ReturnType<typeof createAppBuildDispatcher> | undefined;
  let planDispatch: ReturnType<typeof createPlanDispatcher> | undefined;
  let documentDispatch: ReturnType<typeof createPlanDocumentDispatcher> | undefined;
  let slack: Awaited<ReturnType<typeof createSlackPromptComposition>>;
  const chatObjects = chatObjectStore();
  let importCleanup: ReturnType<typeof createObjectCleanupSweep> | undefined;
  let importSweep: Promise<void> | undefined;
  let importTimer: ReturnType<typeof setInterval> | undefined;
  let hostedSweep: Promise<void> | undefined;
  let hostedTimer: ReturnType<typeof setInterval> | undefined;
  const hostedAbort = new AbortController();
  let apps: ReturnType<typeof createAppComposition>;
  const appJobs: ReturnType<typeof repeatFromStart>[] = [];
  const appAbort = new AbortController();
  let resourceBilling: ReturnType<typeof createResourceBilling>;
  const sweepTelemetry: ReturnType<typeof createBackgroundJob>[] = [];
  let recommendations: ReturnType<typeof createRecommendationComposition> | undefined;
  let memberProfiles: ReturnType<typeof createMemberProfileComposition> | undefined;
  let agentLessons: ReturnType<typeof createAgentLessonComposition> | undefined;
  let rowAssignments: ReturnType<typeof createRowAssignmentComposition> | undefined;
  let socialPublisher: ReturnType<typeof createSocialPublisherComposition> | undefined;
  try {
    email = emailEnabled && role !== 'knowledge' ? await createEmailDeliveryComposition() : undefined;
    resources = isolatedStorageEnabled() ? createTableAuthoringComposition() : undefined;
    if (role === 'knowledge' && !resources) throw new Error('The knowledge worker requires isolated workspace storage');
    if (resources) registerFlagSubjectResolver(resources.flagContext);
    // Core: chats, tasks, plans, Slack, email, scheduled sweeps and the health-check workflow.
    const coreResources = role === 'knowledge' ? undefined : resources;
    // Knowledge: source sync, document parsing and delivery to Keep.
    const knowledgeResources = role === 'core' ? undefined : resources;
    if (coreResources) {
      memberProfiles = createMemberProfileComposition({
        runtime: coreResources.runtime,
        source: coreResources.memberProfiles,
        discover: coreResources.readyTaskWorkspaces,
      });
      agentLessons = createAgentLessonComposition({
        runtime: coreResources.runtime,
        discover: coreResources.readyTaskWorkspaces,
      });
      socialPublisher = createSocialPublisherComposition({
        runtime: coreResources.runtime,
        discover: coreResources.readyTaskWorkspaces,
      });
      const cleanup = (importCleanup = chatObjects
        ? createObjectCleanupSweep(coreResources.runtime, chatObjects)
        : undefined);
      const translations = createTableSearchSweep(coreResources.runtime, coreResources.readyTaskWorkspaces);
      const cleanupJob = cleanup ? createBackgroundJob('object-cleanup', 60) : undefined;
      const searchJob = createBackgroundJob('table-search', 60);
      const namesJob = createBackgroundJob('table-names', 60);
      const nameResources = coreResources;
      let namesCursor: string | null = null;
      const nameSweep = async () => {
        const workspaces = await nameResources.readyTaskWorkspaces(namesCursor);
        const failures: unknown[] = [];
        for (const workspaceId of workspaces) {
          namesCursor = workspaceId;
          try {
            const status = await nameResources.convertTableName(workspaceId);
            if (status === 'converted' || status === 'work-pending')
              Runtime.instance().logger.info('Table name conversion', { workspaceId, status });
          } catch (error) {
            if (workspaceSchemaPending(error)) continue;
            Runtime.instance().logger.error('Table name conversion failed', { workspaceId, ...errorAttributes(error) });
            failures.push(error);
          }
        }
        if (!workspaces.length) namesCursor = null;
        if (failures.length) throw new AggregateError(failures, 'Table name conversion sweep failed');
      };
      const secretsJob = createBackgroundJob('secrets-expiry', 60);
      const secretsSweep = createSecretsSweep(coreResources.runtime, coreResources.readyTaskWorkspaces);
      sweepTelemetry.push(searchJob, namesJob, secretsJob, ...(cleanupJob ? [cleanupJob] : []));
      const sweep = () => {
        importSweep ??= (async () => {
          await cleanupJob
            ?.run(() => cleanup!.sweep())
            .catch(() => Runtime.instance().logger.error('Object cleanup sweep failed'));
          await searchJob.run(translations).catch(() => Runtime.instance().logger.error('Table search sweep failed'));
          await namesJob
            .run(nameSweep)
            .catch(() => Runtime.instance().logger.error('Table name conversion sweep failed'));
          await secretsJob
            .run(() =>
              secretsSweep((workspaceId, error) =>
                Runtime.instance().logger.error('Secrets sweep failed', { workspaceId, ...errorAttributes(error) }),
              ),
            )
            .catch(() => Runtime.instance().logger.error('Secrets sweep failed'));
        })().finally(() => {
          importSweep = undefined;
        });
      };
      importTimer = setInterval(sweep, 60_000);
      importTimer.unref();
      sweep();
      const sweepHosted = createWorkspaceMcpHostedSweep(coreResources.runtime);
      if (sweepHosted) {
        const hostedJob = createBackgroundJob('mcp-hosted-sweep', 300);
        sweepTelemetry.push(hostedJob);
        const tick = () => {
          hostedSweep ??= hostedJob
            .run(() => sweepHosted(hostedAbort.signal))
            .catch(() => Runtime.instance().logger.error('Hosted MCP sweep failed'))
            .finally(() => {
              hostedSweep = undefined;
            });
        };
        hostedTimer = setInterval(tick, 5 * 60_000);
        hostedTimer.unref();
      }
      const appWork = (apps = createAppComposition({
        runtime: coreResources.runtime,
        discover: coreResources.readyTaskWorkspaces,
      }));
      if (appWork) {
        const schedule = (
          name: 'reconcile' | 'usage',
          job: ReturnType<typeof createBackgroundJob>,
          seconds: number,
        ) => {
          sweepTelemetry.push(job);
          const work = name === 'reconcile' ? appWork.reconcile : appWork.meter;
          appJobs.push(
            repeatFromStart(
              () =>
                job
                  .run(() => work(appAbort.signal))
                  .catch(error => Runtime.instance().logger.error(`App ${name} failed`, errorAttributes(error))),
              seconds * 1000,
            ),
          );
        };
        schedule('reconcile', createBackgroundJob('app-reconcile', 300), 300);
        schedule('usage', createBackgroundJob('app-usage', 3600), 3600);
      }
      resourceBilling = createResourceBilling({
        runtime: coreResources.runtime,
        discover: coreResources.readyTaskWorkspaces,
      });
      if (resourceBilling) {
        const billing = resourceBilling;
        for (const [name, work] of [
          ['compute', billing.meterCompute],
          ['storage', billing.meterStorage],
        ] as const) {
          const job = createBackgroundJob(`resource-${name}`, 3600);
          sweepTelemetry.push(job);
          appJobs.push(
            repeatFromStart(
              () =>
                job
                  .run(() => work(appAbort.signal))
                  .catch(error =>
                    Runtime.instance().logger.error(`Resource ${name} metering failed`, errorAttributes(error)),
                  ),
              3600 * 1000,
            ),
          );
        }
      }
      const flagContext = coreResources.flagContext;
      const creditAlerts = createCreditAlerts({
        runtime: coreResources.runtime,
        discover: coreResources.readyTaskWorkspaces,
        profiles: coreResources.memberProfiles,
        workspace: async workspaceId => (await flagContext({ workspaceId })).workspace,
      });
      if (creditAlerts) {
        const job = createBackgroundJob('credit-alerts', 300);
        sweepTelemetry.push(job);
        appJobs.push(
          repeatFromStart(
            () =>
              job
                .run(() => creditAlerts.run(appAbort.signal))
                .catch(error => Runtime.instance().logger.error('Credit alerts failed', errorAttributes(error))),
            300 * 1000,
          ),
        );
      }
    }
    if (
      (process.env.SLACK_LINK_PROMPTS_ENABLED === 'true' || process.env.SLACK_DIRECT_MESSAGES_ENABLED === 'true') &&
      !resources
    )
      throw new Error('Slack requires isolated workspace storage');
    // Retained knowledge citations are rechecked in every agent, Slack and task transaction.
    const guarded = coreResources ? withKnowledgeSourceAuthorization(coreResources.runtime) : undefined;
    modelBundles = coreResources ? createModelBundleRegistry() : undefined;
    tasks = coreResources
      ? createTaskComposition(coreResources.runtime, undefined, undefined, modelBundles?.store)
      : undefined;
    await tasks?.registerModelBundle();
    const taskFailure = (workspaceId: string, taskId: string) =>
      Runtime.instance().logger.error('Task dispatch will retry', { workspaceId, taskId });
    taskDispatch = coreResources ? createTaskDispatcher(taskFailure) : undefined;
    const taskRecovery =
      coreResources && taskDispatch
        ? createTaskRecovery({
            runtime: coreResources.runtime,
            discover: coreResources.readyTaskWorkspaces,
            wake: taskDispatch.wake,
            failure: taskFailure,
          })
        : undefined;
    const agentTasks = coreResources ? createAgentTasks(coreResources.runtime) : undefined;
    rowAssignments =
      coreResources && agentTasks && taskDispatch
        ? createRowAssignmentComposition({
            runtime: coreResources.runtime,
            agentTasks,
            discover: coreResources.readyTaskWorkspaces,
            wake: taskDispatch.wake,
          })
        : undefined;
    const planFailure = (workspaceId: string, planId: string) =>
      Runtime.instance().logger.error('Plan dispatch will retry', { workspaceId, planId });
    planDispatch = coreResources ? createPlanDispatcher(planFailure) : undefined;
    documentDispatch = coreResources
      ? createPlanDocumentDispatcher((workspaceId, planId) =>
          Runtime.instance().logger.error('Plan document dispatch will retry', { workspaceId, planId }),
        )
      : undefined;
    const documents =
      coreResources && documentDispatch
        ? createPlanDocumentComposition({
            runtime: coreResources.runtime,
            profiles: coreResources.memberProfiles,
            files: chatObjects ? createFiles(coreResources.runtime, chatObjects) : undefined,
            objects: chatObjects ?? undefined,
            start: documentDispatch.start,
          })
        : undefined;
    const plans =
      coreResources && guarded && planDispatch
        ? createPlanComposition({
            runtime: guarded,
            discover: coreResources.readyTaskWorkspaces,
            wakePlan: planDispatch.wake,
            wakeTask: (workspaceId, taskId) => taskDispatch?.wake(workspaceId, taskId) ?? Promise.resolve(),
            knowledge: createKnowledgeTools({ runtime: coreResources.runtime }),
            files: chatObjects ? createFiles(guarded, chatObjects) : undefined,
            ...(documents ? { documents } : {}),
          })
        : undefined;
    slack = guarded
      ? await createSlackPromptComposition(guarded, tasks?.model ?? null, undefined, chatObjects ?? undefined)
      : undefined;
    const skillClient = configuredSkillClient();
    const agents = guarded
      ? createAgentComposition(
          guarded,
          chatObjects ? createSkillExecutionFactory(chatObjects, skillClient) : undefined,
          chatObjects ? createFiles(guarded, chatObjects) : undefined,
        )
      : undefined;
    const skillImports =
      guarded && chatObjects
        ? createSkillActivities(guarded, chatObjects, () => skillClient?.available?.() ?? false)
        : undefined;
    const evalRuns = guarded
      ? createEvalActivities(
          guarded,
          createKnowledgeTools({ runtime: guarded }),
          chatObjects ? { attachments: chatObjects, snapshots: chatObjects } : undefined,
        )
      : undefined;
    codingDispatch = coreResources && coding ? createCodingRunDispatcher() : undefined;
    workflowCoding = coreResources && coding ? createWorkflowCodingDispatcher() : undefined;
    const codingRuns =
      coding && codingDispatch
        ? codingRunsFactory(coding.backend, coding.configuration, codingDispatch.start)
        : undefined;
    appBuilds = coreResources ? createAppBuildDispatcher() : undefined;
    const conversations = coreResources
      ? createConversationActivities(
          coreResources.runtime,
          undefined,
          chatObjects ? { attachments: chatObjects, snapshots: chatObjects } : undefined,
          undefined,
          chatObjects ? createFiles(coreResources.runtime, chatObjects) : undefined,
          undefined,
          undefined,
          chatObjects ? createSkillExecutionFactory(chatObjects, skillClient) : undefined,
          planDispatch?.wake,
          (workspaceId, taskId) => taskDispatch?.wake(workspaceId, taskId) ?? Promise.resolve(),
          async workspaceId => (await coreResources.flagContext({ workspaceId })).workspace?.slug,
          chatExecution,
          codingRuns,
          appEditingFromEnvironment(coreResources.runtime, {
            start: appBuilds!.start,
            builders: () => appBuilders(appBuilder(), appHost()),
          }),
          undefined,
          coreResources.githubSubscriptions,
          chatObjects ?? undefined,
        )
      : undefined;
    const gmail = coreResources ? createGoogleHeartbeatActivities(coreResources.runtime) : undefined;
    const workflowSlack = guarded ? slackActionsFromEnvironment()?.(guarded) : undefined;
    const meteredWorkflowStep =
      <T>(advance: (work: unknown) => Promise<T>) =>
      (work: unknown) =>
        resourceBilling ? resourceBilling.workflowStep(work, () => advance(work)) : advance(work);
    const meteredTaskActivities = (activities: NonNullable<typeof tasks>['activities']) => ({
      ...activities,
      processAgentTaskStep: (workspaceId: string, taskId: string) =>
        resourceBilling
          ? resourceBilling.agentTaskStep(workspaceId, taskId, () =>
              activities.processAgentTaskStep(workspaceId, taskId),
            )
          : activities.processAgentTaskStep(workspaceId, taskId),
      processAgentTask: (workspaceId: string, taskId: string) =>
        resourceBilling
          ? resourceBilling.agentTaskStep(workspaceId, taskId, () => activities.processAgentTask(workspaceId, taskId))
          : activities.processAgentTask(workspaceId, taskId),
    });
    const workflows = coreResources
      ? {
          advanceWorkflow: meteredWorkflowStep(
            createWorkflows(coreResources.runtime, {
              decide: evaluateWorkflowDecision,
              ...(workflowSlack ? { slackActions: workflowSlack } : {}),
              ...(snippets ? { snippets } : {}),
              ...(workflowCoding ? { codingRuns: workflowCoding.runner } : {}),
              ...(agentTasks
                ? {
                    agentTasks: createWorkflowAgentTasks(
                      agentTasks,
                      (workspaceId, taskId) => taskDispatch?.wake(workspaceId, taskId) ?? Promise.resolve(),
                    ),
                  }
                : {}),
            }).activity,
          ),
        }
      : undefined;
    recommendations = coreResources
      ? createRecommendationComposition(coreResources.runtime, (event, workspaceId, membershipId) =>
          Runtime.instance().logger.info('Recommendation background work', { event, workspaceId, membershipId }),
        )
      : undefined;
    const worker =
      role === 'knowledge'
        ? undefined
        : await Worker.create({
            connection,
            namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
            taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
            activities: {
              ...activities,
              ...coreResources?.activities,
              ...agents?.activities,
              ...(tasks ? meteredTaskActivities(tasks.activities) : {}),
              ...taskRecovery,
              ...plans?.activities,
              ...documents?.activities,
              ...email?.activities,
              ...conversations,
              ...(coreResources ? createConversationMaintenanceActivities(coreResources.runtime) : {}),
              ...workflows,
              ...slack?.activities,
              ...apps?.activities,
              ...gmail,
              ...skillImports,
              ...evalRuns,
              ...(coreResources ? createWorkspaceMcpDiscoveryActivities(coreResources.runtime) : {}),
              ...(coreResources && coding
                ? createCodingRunActivities(
                    coreResources.runtime,
                    coding.backend,
                    coding.configuration,
                    chatObjects ? createFiles(coreResources.runtime, chatObjects) : undefined,
                  )
                : {}),
              ...(coreResources ? createCodeSessionActivities(coreResources.runtime, coding ?? undefined) : {}),
              ...(coreResources && coding
                ? createWorkflowCodingActivities(coreResources.runtime, coding.backend, coding.configuration)
                : {}),
            },
            ...workflowSource('workflows', workerTelemetry(telemetry)),
            shutdownGraceTime: '5 seconds',
          });
    const recommendationWorker = recommendations
      ? await Worker.create({
          ...workflowSource('recommendation-workflows', workerTelemetry(telemetry)),
          connection,
          namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
          taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-recommendations`,
          activities: recommendations.activities,
          maxConcurrentActivityTaskExecutions: recommendations.concurrency,
          shutdownGraceTime: '55 seconds',
        })
      : undefined;
    const knowledgeParts = (runtime: NonNullable<typeof knowledgeResources>['runtime']) => {
      const google = createGoogleKnowledgeParts({ runtime, ...knowledgeMediaRecognition(runtime) });
      const slack = createSlackKnowledgeParts({ runtime });
      const github = createGitHubKnowledgeParts({ runtime });
      const atlassian = createAtlassianKnowledgeParts({ runtime });
      const defaults = createDefaultKnowledgeParts({
        runtime,
        engines: {
          google: google.service,
          slack: slack.service,
          github: github.service,
          atlassian: atlassian.service,
        },
      });
      const keep = createKnowledgeKeepParts({ runtime });
      return {
        ingest: createKnowledgeActivities(runtime, chatObjects ?? undefined, knowledgeMediaRecognition(runtime)),
        google: google.activities,
        slack: slack.activities,
        github: github.activities,
        atlassian: atlassian.activities,
        defaults: defaults.activities,
        ...(keep ? { keep: keep.activities } : {}),
      };
    };
    const knowledgeWorker = knowledgeResources
      ? await createKnowledgeWorker({ connection, telemetry, parts: knowledgeParts(knowledgeResources.runtime) })
      : undefined;
    const workers = [
      ...(worker ? [worker] : []),
      ...(knowledgeWorker ? [knowledgeWorker] : []),
      ...(recommendationWorker ? [recommendationWorker] : []),
    ];
    await taskDispatch?.startRecovery();
    await planDispatch?.startRecovery();
    const stopSlotMetrics = observeTemporalSlots(() => temporalSlotReadings(workers));
    const outcomes = await Promise.allSettled(
      workers.map(current =>
        current.run().finally(() => {
          for (const peer of workers) if (peer !== current && peer.getState() === 'RUNNING') peer.shutdown();
        }),
      ),
    );
    stopSlotMetrics();
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } finally {
    await rowAssignments?.close();
    await memberProfiles?.close();
    await agentLessons?.close();
    await socialPublisher?.close();
    await recommendations?.close();
    clearInterval(importTimer);
    clearInterval(hostedTimer);
    hostedAbort.abort();
    await importSweep;
    await hostedSweep;
    appAbort.abort();
    await Promise.all(appJobs.map(job => job.stop()));
    await apps?.close();
    await importCleanup?.close();
    for (const job of sweepTelemetry) job.close();
    chatObjects?.close();
    await slack?.close();
    await connection.close();
    await resources?.close();
    await email?.close();
    await tasks?.close();
    await modelBundles?.close();
    await taskDispatch?.close();
    await codingDispatch?.close();
    await workflowCoding?.close();
    await appBuilds?.close();
    await planDispatch?.close();
    await documentDispatch?.close();
  }
}

run()
  .catch(error => {
    captureException(error);
    log('error', 'lifecycle', 'startup_failed');
    process.exitCode = 1;
  })
  .finally(() => Promise.all([telemetry?.shutdown(), shutdownExtensions()]));
