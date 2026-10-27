import '@tulipfarm/config/load-secret-files';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import {
  captureException,
  createBackgroundJob,
  errorAttributes,
  log,
  observeTemporalSlots,
  registerFlagSubjectResolver,
  startTelemetry,
} from '@tulipfarm/observability';
import { shutdownExtensions, startExtensions } from '@tulipfarm/extensions';
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
import { configuredSnippetClient } from '@tulipfarm/workflow-snippets/client';
import { createTaskComposition } from './task-composition.ts';
import { createModelBundleRegistry } from './model-bundle-registry.ts';
import { createTaskDispatcher, createTaskRecovery } from './task-dispatch.ts';
import { createPlanComposition, createPlanDispatcher } from './plan-composition.ts';
import { createKnowledgeTools } from './knowledge-tools-composition.ts';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { createSlackPromptComposition } from './slack-composition.ts';
import { chatObjectStore } from '@tulipfarm/workspaces/chat-objects';
import { createObjectCleanupSweep, createTableSearchSweep } from './table-cleanup.ts';
import { githubRuntimeConfiguration } from '@tulipfarm/github/configuration';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createKnowledgeActivities } from './knowledge-activities.ts';
import { knowledgeMediaRecognition } from './media-recognition.ts';
import { createFiles } from '@tulipfarm/files';
import { createKnowledgeEmbeddingWorker } from './knowledge-embedding-composition.ts';
import { createGoogleKnowledgeWorker } from './knowledge-google-composition.ts';
import { createSlackKnowledgeWorker } from './knowledge-slack-composition.ts';
import { createGitHubKnowledgeWorker } from './knowledge-github-composition.ts';
import { createAtlassianKnowledgeWorker } from './knowledge-atlassian-composition.ts';
import { createDefaultKnowledgeWorker } from './knowledge-defaults-composition.ts';
import { createDefaultKnowledgeGate, withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import { createWorkflowAgentTasks } from './workflow-agent-tasks.ts';
import { createSkillActivities } from './skill-activities.ts';
import { configuredSkillClient } from '@tulipfarm/workflow-snippets/client';
import { createSkillExecutionFactory } from '@tulipfarm/agents/skill-execution';
import { slackActionsFromEnvironment } from '@tulipfarm/agents/slack-environment';
import { createRecommendationComposition } from './recommendation-activities.ts';
import { createMemberProfileComposition } from './member-profile-composition.ts';
import { createSocialPublisherComposition } from './social-publisher-composition.ts';

// Bare package names in TULIPFARM_EXTENSIONS resolve from this app.
await startExtensions('worker', { resolve: specifier => import.meta.resolve(specifier) });
const telemetry = startTelemetry(readBuildInfo('worker', new URL('../version.json', import.meta.url)));

async function run() {
  const github = githubRuntimeConfiguration();
  if (github.oauth) {
    if (!isolatedStorageEnabled()) throw new Error('GitHub requires isolated workspace storage');
    integrationCredentialKeyring();
  }
  // Fails startup on an invalid model catalog or provider environment.
  for (const warning of loadModelCatalog().warnings) console.warn(JSON.stringify({ level: 'warn', msg: warning }));
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
  let planDispatch: ReturnType<typeof createPlanDispatcher> | undefined;
  let slack: Awaited<ReturnType<typeof createSlackPromptComposition>>;
  const chatObjects = chatObjectStore();
  let importCleanup: ReturnType<typeof createObjectCleanupSweep> | undefined;
  let importSweep: Promise<void> | undefined;
  let importTimer: ReturnType<typeof setInterval> | undefined;
  const sweepTelemetry: ReturnType<typeof createBackgroundJob>[] = [];
  let knowledgeEmbeddings: Awaited<ReturnType<typeof createKnowledgeEmbeddingWorker>>;
  let recommendations: ReturnType<typeof createRecommendationComposition> | undefined;
  let memberProfiles: ReturnType<typeof createMemberProfileComposition> | undefined;
  let socialPublisher: ReturnType<typeof createSocialPublisherComposition> | undefined;
  try {
    email = emailEnabled ? await createEmailDeliveryComposition() : undefined;
    resources = isolatedStorageEnabled() ? createTableAuthoringComposition() : undefined;
    if (resources) {
      registerFlagSubjectResolver(resources.flagContext);
      memberProfiles = createMemberProfileComposition({
        runtime: resources.runtime,
        source: resources.memberProfiles,
        discover: resources.readyTaskWorkspaces,
      });
      socialPublisher = createSocialPublisherComposition({
        runtime: resources.runtime,
        discover: resources.readyTaskWorkspaces,
      });
      const cleanup = (importCleanup = chatObjects
        ? createObjectCleanupSweep(resources.runtime, chatObjects)
        : undefined);
      const translations = createTableSearchSweep(resources.runtime, resources.readyTaskWorkspaces);
      const cleanupJob = cleanup ? createBackgroundJob('object-cleanup', 60) : undefined;
      const searchJob = createBackgroundJob('table-search', 60);
      const namesJob = createBackgroundJob('table-names', 60);
      const nameResources = resources;
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
            Runtime.instance().logger.error('Table name conversion failed', { workspaceId, ...errorAttributes(error) });
            failures.push(error);
          }
        }
        if (!workspaces.length) namesCursor = null;
        if (failures.length) throw new AggregateError(failures, 'Table name conversion sweep failed');
      };
      sweepTelemetry.push(searchJob, namesJob, ...(cleanupJob ? [cleanupJob] : []));
      const sweep = () => {
        importSweep ??= (async () => {
          await cleanupJob
            ?.run(() => cleanup!.sweep())
            .catch(() => Runtime.instance().logger.error('Object cleanup sweep failed'));
          await searchJob.run(translations).catch(() => Runtime.instance().logger.error('Table search sweep failed'));
          await namesJob
            .run(nameSweep)
            .catch(() => Runtime.instance().logger.error('Table name conversion sweep failed'));
        })().finally(() => {
          importSweep = undefined;
        });
      };
      importTimer = setInterval(sweep, 60_000);
      importTimer.unref();
      sweep();
    }
    if (
      (process.env.SLACK_LINK_PROMPTS_ENABLED === 'true' || process.env.SLACK_DIRECT_MESSAGES_ENABLED === 'true') &&
      !resources
    )
      throw new Error('Slack requires isolated workspace storage');
    // Retained knowledge citations are rechecked in every agent, Slack and task transaction.
    const guarded = resources ? withKnowledgeSourceAuthorization(resources.runtime) : undefined;
    modelBundles = resources ? createModelBundleRegistry() : undefined;
    tasks = resources ? createTaskComposition(resources.runtime, undefined, undefined, modelBundles?.store) : undefined;
    await tasks?.registerModelBundle();
    const taskFailure = (workspaceId: string, taskId: string) =>
      Runtime.instance().logger.error('Task dispatch will retry', { workspaceId, taskId });
    taskDispatch = resources ? createTaskDispatcher(taskFailure) : undefined;
    const taskRecovery =
      resources && taskDispatch
        ? createTaskRecovery({
            runtime: resources.runtime,
            discover: resources.readyTaskWorkspaces,
            wake: taskDispatch.wake,
            failure: taskFailure,
          })
        : undefined;
    const agentTasks = resources ? createAgentTasks(resources.runtime) : undefined;
    const planFailure = (workspaceId: string, planId: string) =>
      Runtime.instance().logger.error('Plan dispatch will retry', { workspaceId, planId });
    planDispatch = resources ? createPlanDispatcher(planFailure) : undefined;
    const plans =
      resources && guarded && planDispatch
        ? createPlanComposition({
            runtime: guarded,
            discover: resources.readyTaskWorkspaces,
            wakePlan: planDispatch.wake,
            wakeTask: (workspaceId, taskId) => taskDispatch?.wake(workspaceId, taskId) ?? Promise.resolve(),
            knowledge: createKnowledgeTools({ runtime: resources.runtime }),
            files: chatObjects ? createFiles(guarded, chatObjects) : undefined,
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
    const conversations = resources
      ? createConversationActivities(
          resources.runtime,
          undefined,
          chatObjects ? { attachments: chatObjects, snapshots: chatObjects } : undefined,
          undefined,
          chatObjects ? createFiles(resources.runtime, chatObjects) : undefined,
          undefined,
          undefined,
          chatObjects ? createSkillExecutionFactory(chatObjects, skillClient) : undefined,
          planDispatch?.wake,
          (workspaceId, taskId) => taskDispatch?.wake(workspaceId, taskId) ?? Promise.resolve(),
        )
      : undefined;
    const gmail = resources ? createGoogleHeartbeatActivities(resources.runtime) : undefined;
    const snippets = configuredSnippetClient();
    const workflowSlack = guarded ? slackActionsFromEnvironment()?.(guarded) : undefined;
    const workflows = resources
      ? {
          advanceWorkflow: createWorkflows(resources.runtime, {
            ...(workflowSlack ? { slackActions: workflowSlack } : {}),
            ...(snippets ? { snippets } : {}),
            ...(agentTasks
              ? {
                  agentTasks: createWorkflowAgentTasks(
                    agentTasks,
                    (workspaceId, taskId) => taskDispatch?.wake(workspaceId, taskId) ?? Promise.resolve(),
                  ),
                }
              : {}),
          }).activity,
        }
      : undefined;
    recommendations = resources
      ? createRecommendationComposition(resources.runtime, (event, workspaceId, membershipId) =>
          Runtime.instance().logger.info('Recommendation background work', { event, workspaceId, membershipId }),
        )
      : undefined;
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
      workflowsPath: fileURLToPath(new URL(`./workflows${extname(import.meta.filename)}`, import.meta.url)),
      activities: {
        ...activities,
        ...resources?.activities,
        ...agents?.activities,
        ...tasks?.activities,
        ...taskRecovery,
        ...plans?.activities,
        ...email?.activities,
        ...conversations,
        ...(resources
          ? createConversationMaintenanceActivities(resources.runtime, {
              embeddings: () => knowledgeEmbeddings?.service,
            })
          : {}),
        ...workflows,
        ...slack?.activities,
        ...gmail,
        ...skillImports,
      },
      ...workerTelemetry(telemetry),
      shutdownGraceTime: '5 seconds',
    });
    const knowledgeWorker = resources
      ? await Worker.create({
          ...workerTelemetry(telemetry),
          connection,
          namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
          taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge`,
          workflowsPath: fileURLToPath(
            new URL(`./knowledge-workflows${extname(import.meta.filename)}`, import.meta.url),
          ),
          activities: createKnowledgeActivities(
            resources.runtime,
            chatObjects ?? undefined,
            knowledgeMediaRecognition(resources.runtime),
          ),
          maxConcurrentActivityTaskExecutions: 2,
          shutdownGraceTime: '40 seconds',
        })
      : undefined;
    const recommendationWorker = recommendations
      ? await Worker.create({
          ...workerTelemetry(telemetry),
          connection,
          namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
          taskQueue: `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-recommendations`,
          workflowsPath: fileURLToPath(
            new URL(`./recommendation-workflows${extname(import.meta.filename)}`, import.meta.url),
          ),
          activities: recommendations.activities,
          maxConcurrentActivityTaskExecutions: recommendations.concurrency,
          shutdownGraceTime: '55 seconds',
        })
      : undefined;
    const googleKnowledge = resources
      ? await createGoogleKnowledgeWorker({
          runtime: resources.runtime,
          connection,
          telemetry,
          gate: createDefaultKnowledgeGate({ runtime: resources.runtime }),
          ...knowledgeMediaRecognition(resources.runtime),
        })
      : undefined;
    const slackKnowledge = resources
      ? await createSlackKnowledgeWorker({
          runtime: resources.runtime,
          connection,
          telemetry,
          gate: createDefaultKnowledgeGate({ runtime: resources.runtime }),
        })
      : undefined;
    const githubKnowledge = resources
      ? await createGitHubKnowledgeWorker({
          runtime: resources.runtime,
          connection,
          telemetry,
          gate: createDefaultKnowledgeGate({ runtime: resources.runtime }),
        })
      : undefined;
    const atlassianKnowledge = resources
      ? await createAtlassianKnowledgeWorker({
          runtime: resources.runtime,
          connection,
          telemetry,
          gate: createDefaultKnowledgeGate({ runtime: resources.runtime }),
        })
      : undefined;
    const defaultKnowledge =
      resources && googleKnowledge && slackKnowledge && githubKnowledge && atlassianKnowledge
        ? await createDefaultKnowledgeWorker({
            runtime: resources.runtime,
            connection,
            telemetry,
            engines: {
              google: googleKnowledge.service,
              slack: slackKnowledge.service,
              github: githubKnowledge.service,
              atlassian: atlassianKnowledge.service,
            },
          })
        : undefined;
    knowledgeEmbeddings = resources
      ? await createKnowledgeEmbeddingWorker({
          runtime: resources.runtime,
          connection,
          telemetry,
          gate: createDefaultKnowledgeGate({ runtime: resources.runtime }),
          ...(googleKnowledge ? { google: googleKnowledge.service } : {}),
          ...(slackKnowledge ? { slack: slackKnowledge.service } : {}),
          ...(githubKnowledge ? { github: githubKnowledge.service } : {}),
          ...(atlassianKnowledge ? { atlassian: atlassianKnowledge.service } : {}),
        })
      : undefined;
    const workers = [
      worker,
      ...(knowledgeWorker ? [knowledgeWorker] : []),
      ...(recommendationWorker ? [recommendationWorker] : []),
      ...(googleKnowledge ? [googleKnowledge.worker] : []),
      ...(slackKnowledge ? [slackKnowledge.worker] : []),
      ...(githubKnowledge ? [githubKnowledge.worker] : []),
      ...(atlassianKnowledge ? [atlassianKnowledge.worker] : []),
      ...(defaultKnowledge ? [defaultKnowledge.worker] : []),
      ...(knowledgeEmbeddings ? [knowledgeEmbeddings.worker] : []),
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
    await memberProfiles?.close();
    await socialPublisher?.close();
    await recommendations?.close();
    await knowledgeEmbeddings?.close();
    clearInterval(importTimer);
    await importSweep;
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
    await planDispatch?.close();
  }
}

run()
  .catch(error => {
    captureException(error);
    log('error', 'lifecycle', 'startup_failed');
    process.exitCode = 1;
  })
  .finally(() => Promise.all([telemetry?.shutdown(), shutdownExtensions()]));
