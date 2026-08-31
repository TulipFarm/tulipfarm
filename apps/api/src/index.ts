import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  createSubagentSpawning,
  delegationCatalogOf,
  GuardrailsService,
} from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { FileService, PgFileRepo } from "@tulipfarm/files";
import { FetchEgressHttp, GuardedEgressHttp, PublicOriginsService } from "@tulipfarm/integrations";
import {
  buildDefaultRegistry,
  enqueueIndex,
  KnowledgeService,
  makeIndexQueueStats,
  PageRetrievalService,
  PgConnectorStateRepo,
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
  PgKnowledgeSubjectStore,
  registerConnectorSync,
  registerEmbeddingBackfill,
  registerKnowledgeIndexing,
  subscribeKnowledgeIndexing,
} from "@tulipfarm/knowledge";
import { KvService, PgKvRepo } from "@tulipfarm/kv";
import { EmbeddingService, LlmService } from "@tulipfarm/llm";
import { MutationKillSwitchGuard } from "@tulipfarm/observability";
import {
  ArtifactService,
  DurableInvocationGateway,
  DurableWaitManager,
  PgDurableInvocationStore,
  RunCancellationManager,
  RunResumeGateway,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { RUN_ARTIFACT_SCHEMAS } from "@tulipfarm/schema";
import {
  loadEncryptionKeys,
  loadOrProvisionActiveDek,
  PgDekRepo,
  PgSecretRepo,
  SecretsService,
} from "@tulipfarm/secrets";
import { SkillBashRunner, SkillCommandRunner } from "@tulipfarm/skill-sandbox";
import type { AuthOAuth2Step } from "@tulipfarm/soul";
import {
  ActiveRoutineCatalog,
  type CommitActor,
  type CredentialProvider,
  compileExecutionBundle,
  GitSoulTreeReader,
  GitSyncService,
  getDefaultAssistant,
  loadBundledIntegrations,
  loadBundledSkills,
  loadDisabledBundledSkills,
  PgBundleStore,
  resolveAuthSteps,
  resolveSoulPath,
  runSoulMigrations,
  SoulLoader,
  SoulPublicationCoordinator,
  SoulPublisher,
  syncBundledSkillsIntoSoul,
} from "@tulipfarm/soul";
import {
  ArtifactStore,
  BudgetStore,
  ChannelMentionedThreadStore,
  ChannelRunDeliveryStore,
  ChildLinkAncestryStore,
  ChildLinkStore,
  createBlobPort,
  EventStore,
  ensureBundledBucket,
  ensureEmbeddingIndexes,
  IntegrationStore,
  KillSwitchRepo,
  PgGroupRepo,
  PgIntegrationAuthRequestRepo,
  PgPrincipalRepo,
  PgRoleRepo,
  PgSoulPublicationStore,
  PublicOriginStore,
  RunEventStore,
  RunStore,
  SoulRepositoryStore,
  TaskRepo,
  WaitStore,
  writeBucketSecrets,
} from "@tulipfarm/storage";
import { PgEffectStore } from "@tulipfarm/tool-broker";
import { ApprovalsRepo, collectHeldRoleIds, ToolApprovalService } from "@tulipfarm/tool-host";
import { config } from "dotenv";
import type { FastifyBaseLogger } from "fastify";
import { PgBoss } from "pg-boss";
import { subscribeActivityLogging } from "./activity/events";
import { PgActivityRepo } from "./activity/repo";
import { ActivityService } from "./activity/service";
import {
  llmProbe,
  postgresProbe,
  queueProbe,
  soulProbe,
  soulPublicationProbe,
} from "./admin/health";
import { modelReachability } from "./admin/model-reachability";
import { OperationalNotImplementedError } from "./admin/routes";
import { createRunReader } from "./admin/run-reader";
import { createRuntimeOperationalApi } from "./admin/runtime";
import { buildApp } from "./app";
import { RoutineApprovalService } from "./approvals/routine-approvals";
import { AuditReadService } from "./audit/read-service";
import { PgAuditEventRepo } from "./audit/repo";
import { AuditService } from "./audit/service";
import { PgTokenRepo } from "./auth/api-tokens";
import { PgUserInviteRepo } from "./auth/invites";
import { makeRequireAuth } from "./auth/middleware";
import { DEFAULT_SESSION_TTL_SECONDS, PgSessionStore } from "./auth/session-store";
import { PgUserRepo } from "./auth/users";
import {
  deploymentGateOptions,
  LiveRouteAuthorizer,
  makeAuthorizationCheck,
  makeRequireAuthorization,
} from "./authz/route-gate";
import { AuthzAdminService } from "./authz/service";
import { PgConversationRepo } from "./chat/conversations";
import { PgMessageRepo } from "./chat/messages";
import { allowedToolNamesFor } from "./chat/turn-helpers";
import { PgConversationStore } from "./conversations/store.pg";
import { buildCurator } from "./curator/compose";
import { CURATOR_SWEEP_QUEUE, registerCuratorSweepSchedule } from "./curator/sweep-schedule";
import {
  ambientTransactionPort,
  connectPg,
  type Queryable,
  runtimePoolOptions,
  startRuntimePool,
  transactionPort,
  withTransaction,
} from "./db";
import { logEnvironmentStatus, validateEnvironment } from "./env";
import { FeedbackRepo } from "./feedback/repo";
import { buildFileKnowledgeBridge } from "./files/knowledge-bridge";
import { registerGuardrailsReload } from "./guardrails/reload";
import { createHookExecutor } from "./hooks/executor";
import { PgRawPayloadVault } from "./hooks/raw-payload-vault";
import { webhookSecretPort } from "./hooks/secret-port";
import { PgApiClientRepo } from "./identity/api-clients";
import { buildApiAuthorityLayerResolver } from "./identity/authority-layers";
import { channelBindKeyResolver } from "./identity/channel-link";
import { PgExternalIdentityRepo } from "./identity/external-links";
import { ExternalLinkKnowledgeIdentityMap } from "./identity/knowledge-identity-map";
import { reconcileSoulRoles, registerSoulRoleReconcile } from "./identity/role-reconcile";
import { syncDeploymentRoles } from "./identity/roles";
import { IngressIdentityResolver } from "./ingress/identity";
import {
  IngressDeliveriesRepo,
  IntegrationConversationsRepo,
  IntegrationEventsRepo,
} from "./ingress/repo";
import { resolveSecretRef } from "./integrations/connection-env";
import { PgPrincipalProviderTokenRepo } from "./integrations/principal-tokens";
import { InternalChildRoutineHost } from "./internal/child-routine-host";
import { IngressDeliveryHost } from "./internal/delivery-host";
import { InternalEmitHost } from "./internal/emit-host";
import { ModelSelectorGate, modelGateModeFromEnv } from "./internal/model-authz";
import { InternalRoutineApprovalHost } from "./internal/routine-approval-host";
import { SubagentTurnContextResolver } from "./internal/subagent-context";
import { buildDelegatedToolDispatch } from "./internal/tool-dispatch";
import { ChatTurnContextResolver } from "./internal/turn-context";
import { InternalTurnHost } from "./internal/turn-host";
import { KillSwitchService } from "./kill-switches/service";
import { AuthorLabeller } from "./knowledge/author-label";
import { knowledgeDenialSink as makeKnowledgeDenialSink } from "./knowledge/denial-sink";
import { PageReadGate } from "./knowledge/page-access";
import { ReaderDirectory } from "./knowledge/reader-directory";
import { SubjectDirectory } from "./knowledge/subject-directory";
import { PgSlackKnowledgeCheckpointStore } from "./knowledge-sources/checkpoint-store";
import { PgKnowledgeEmissionSink } from "./knowledge-sources/emission-sink";
import { PgKnowledgeIndexStore } from "./knowledge-sources/index-store";
import {
  CompositeLiveSourceAuthorization,
  SlackTenantLiveAuthorization,
} from "./knowledge-sources/live-authorization";
import { registerSlackKnowledgeSync } from "./knowledge-sources/slack-sync-schedule";
import { PgKnowledgeSourceStore } from "./knowledge-sources/source-store";
import { registerLlmReload } from "./llm-reload";
import { buildMemoryServices } from "./memory/composition";
import { parseObservabilityConfig } from "./observability/config";
import { createEmbeddingUsageSink } from "./observability/embedding-usage";
import { subscribeObservability } from "./observability/events";
import { OtlpMetricsExporter } from "./observability/metrics";
import { registerObsPruneSchedule } from "./observability/prune-schedule";
import { PgObsRepo } from "./observability/repo";
import { PgResourceRepo } from "./observability/resource-repo";
import { startProcessSamplers } from "./observability/samplers";
import { ObservabilityService } from "./observability/service";
import { registerSpendAlertSchedule } from "./observability/spend-alert";
import { createObservabilityTelemetryPort } from "./observability/telemetry-port";
import { OtlpTracesExporter } from "./observability/traces";
import { runPgMigrations } from "./pg-migrate";
import { createAgentDelegation, startChildConversation } from "./platform/delegation";
import { subagentAnswers } from "./platform/subagent-answers";
import { startSubagentRun } from "./platform/subagent-run";
import { readCustomInstructions } from "./preferences/custom-instructions";
import { PgRateLimiter } from "./rate-limit";
import { LiveRecordAuthorizer } from "./resources/authorize";
import { startDelivery } from "./resources/outbox";
import { reconcileResourceTables, registerResourceReconcile } from "./resources/reconcile";
import { PgCounterStore, PgResourceRepoFactory } from "./resources/repo";
import { runCanceller } from "./runs/cancel";
import { RunEventNotifyListener } from "./runs/notify-listener";
import {
  childRoutineTrigger,
  integrationInvoker,
  manualRoutineTrigger,
  scheduledRoutineTrigger,
  triggerRunStarter,
} from "./runtime/invocation-callers";
import {
  ActiveRoutineInvocationResolver,
  ActiveTriggerInvocationResolver,
  ActiveWebhookTriggerResolver,
} from "./runtime/invocation-definitions";
import {
  resolveSoulBundleSigner,
  resolveSoulBundleVerifier,
  type SoulBundleKeyStore,
} from "./runtime/soul-bundle-signer";
import {
  createSoulWriter,
  resolveSoulCommitSigner,
  SYSTEM_SOUL_COMMIT_ACTOR,
} from "./runtime/soul-writer";
import { ScheduleDispatcher } from "./schedule/dispatcher";
import { registerScheduleDispatch } from "./schedule/register";
import { RoutineScheduleStateStore } from "./schedule/state-store";
import { supersedeRoutineRuns } from "./schedule/supersede";
import { bootstrapFromEnv } from "./setup/bootstrap";
import {
  assertNoOrphanedDeks,
  type BootstrapSecretsResult,
  bootstrapSecrets,
  resolveDataDir,
} from "./setup/bootstrap-secrets";
import { PgSetupAdminCreator } from "./setup/first-admin";
import { readSoulConfig, SOUL_GIT_CREDENTIAL_KEY } from "./setup/soul-config";
import {
  provisionIntegrationWorkerCredential,
  provisionWorkerCredential,
} from "./setup/worker-credential";
import { agentForRunResolver, delegableToolNames } from "./soul/agents/registry";
import { bundleRetentionMs, registerSoulBundlePruneSchedule } from "./soul/bundle-prune-schedule";
import { createGitHubSoulCredentialProvider } from "./soul/github-repo-credential";
import { registerSoulPublicationRoutes } from "./soul/publication-routes";
import { composeSkillTools } from "./soul/skills/compose";
import { registerSoulSync } from "./soul-sync";
import { PgSurfaceActionStore } from "./surfaces/action-store";
import { PgSurfaceArtifactStore } from "./surfaces/artifact-store";
import { apiSurfacePresentation, surfaceRendererRegistry } from "./surfaces/renderer-registry";
import { DeclarativeToolSync } from "./tools/declarative/sync";
import { buildGitHubTooling } from "./tools/github/compose";
import { buildGitHubTools } from "./tools/github/tools";
import { githubDisabledSkillNames } from "./tools/github/visibility";
import { buildGoogleTooling } from "./tools/google/compose";
import { buildGoogleTools } from "./tools/google/tools";
import { composeNetworkTools } from "./tools/network/compose";
import { buildToolRegistry } from "./tools/setup";
import { buildSlackTooling } from "./tools/slack/compose";
import { buildSlackTools } from "./tools/slack/tools";
import { EventTriggerGateway } from "./triggers/event-dispatch";

config({ path: ".env.local" });

// Fill any bootstrap secret the operator did not supply, from the data volume or fresh
const secretsBootstrap = ((): BootstrapSecretsResult => {
  try {
    return bootstrapSecrets();
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
})();

// Before anything slow: the bundled bucket restarts until these exist, so every second here is a
// second it spends crash-looping. It cannot write them itself — its image carries no shell.
if (process.env.BUCKET_ADMIN_URL) {
  try {
    writeBucketSecrets(resolveDataDir() ?? process.cwd());
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

validateEnvironment();

const port = Number.parseInt(process.env.PORT || "4010", 10);
const SOUL_SYNC_COMMIT_ACTOR: CommitActor = {
  principalId: "service:tulipfarm-soul-sync",
  name: "TulipFarm Soul Sync",
  email: "",
};
const SOUL_BUNDLE_KEY_PROVISIONING_LOCK = "tulipfarm:soul-bundle-key-provisioning";

function soulBundleKeyStore(
  secretsService: SecretsService,
  database: Queryable
): SoulBundleKeyStore {
  return {
    list: () => secretsService.list(),
    get: (key) => secretsService.get(key),
    set: (key, plaintext, type) => secretsService.set(key, plaintext, type),
    withProvisioningLock: (operation) =>
      withTransaction(database, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          SOUL_BUNDLE_KEY_PROVISIONING_LOCK,
        ]);
        return operation();
      }),
  };
}

async function boot() {
  try {
    // Fills the S3 credentials the blob port is built from below, so it must precede the pool:
    // a deployment whose file store never came up should say so, not serve requests that fail.
    await ensureBundledBucket({ dataDir: resolveDataDir() ?? process.cwd() });
    const migrationPool = await connectPg();
    await runPgMigrations(migrationPool);
    // After migrations, on the owner pool (which has no statement timeout): an ANN index left
    // invalid by an interrupted build is invisible to the planner but still costs every write.
    await ensureEmbeddingIndexes(migrationPool, (msg) => console.log(msg));
    const pool = await startRuntimePool(migrationPool);
    const runEventNotifyListener = new RunEventNotifyListener({
      connectionString: process.env.DATABASE_URL as string,
      ...(runtimePoolOptions() === undefined ? {} : { options: runtimePoolOptions() as string }),
    });
    await runEventNotifyListener
      .start((msg) => console.error(msg))
      .catch((err) =>
        console.error(
          `run event listener failed to start (falling back to polling only): ${err instanceof Error ? err.message : err}`
        )
      );
    const publicOrigins = new PublicOriginsService(
      new PublicOriginStore(pool),
      DEPLOYMENT_BUSINESS_ID
    );
    await publicOrigins.initialize();
    /**
     * One instance, shared by the two halves of D7's personal-credential protocol: the connect
     * route that seals a credential and the resolver that decides a call needs one. They are a
     * protocol, not two features — a resolver that denies with "connect it from Settings" while the
     * connect route is unwired is a dead end for the person reading it, so neither may be
     * configured without the other.
     */
    const principalTokens = new PgPrincipalProviderTokenRepo(pool);

    await assertNoOrphanedDeks((sql) => pool.query(sql), secretsBootstrap);

    const secretRepo = new PgSecretRepo(pool);
    const dekRepo = new PgDekRepo(pool);
    const encryptionKeys = loadEncryptionKeys();
    // Fail-fast boot canary: unwrap the active DEK under the env KEK (auto-provisioning one on
    // wrap throws KeyManagerError → the catch below logs and exits 1, rather than failing later at
    // first secret access. Pre-cutover rows must already have been backfilled to the active DEK.
    const activeDek = await loadOrProvisionActiveDek(dekRepo, encryptionKeys);
    const secretsService = new SecretsService(secretRepo, activeDek);

    // GitHub App installation token instead of a static PAT.
    const integrationStore = new IntegrationStore(transactionPort(pool));
    const soulRepositoryStore = new SoulRepositoryStore(transactionPort(pool));

    let soulPath: string;
    let gitRemoteUrl: string | undefined;
    let gitCredentialProvider: CredentialProvider;

    if (process.env.SOUL_PATH) {
      soulPath = process.env.SOUL_PATH;
      // Soul persists a remote (soul.yaml's gitRemoteUrl + the "soul-git-credential" secret),
      const persistedSoulConfig = await readSoulConfig(soulPath);
      gitRemoteUrl = persistedSoulConfig.gitRemoteUrl ?? process.env.SOUL_GIT_REMOTE_URL;
      const gitCredential =
        (await secretsService.get(SOUL_GIT_CREDENTIAL_KEY).catch(() => undefined)) ??
        process.env.SOUL_GIT_CREDENTIAL;
      gitCredentialProvider = async () => gitCredential;
    } else {
      soulPath = resolveSoulPath(process.env.SOUL_ROOT as string, DEPLOYMENT_BUSINESS_ID);
      const soulRepository = await soulRepositoryStore.get(DEPLOYMENT_BUSINESS_ID);
      gitRemoteUrl = soulRepository
        ? `https://github.com/${soulRepository.owner}/${soulRepository.repo}.git`
        : undefined;
      gitCredentialProvider = soulRepository
        ? createGitHubSoulCredentialProvider({
            integrations: integrationStore,
            businessId: DEPLOYMENT_BUSINESS_ID,
            integrationId: soulRepository.integrationId,
            secrets: secretsService,
          })
        : async () => undefined;
    }

    const runTransactions = transactionPort(pool);
    const bundleKeys = soulBundleKeyStore(secretsService, pool);
    const soulBundleSigner = await resolveSoulBundleSigner(bundleKeys);
    const soulBundleVerifier = await resolveSoulBundleVerifier(secretsService);
    const soulPublications = new SoulPublicationCoordinator(
      new PgSoulPublicationStore(runTransactions),
      new PgBundleStore(runTransactions),
      console
    );
    let gitSync: GitSyncService;
    const soulTreeReader = new GitSoulTreeReader(soulPath);
    const soulPublisher = new SoulPublisher({
      treeReader: soulTreeReader,
      compiler: compileExecutionBundle,
      signer: soulBundleSigner,
      coordinator: soulPublications,
      logger: console,
      businessId: DEPLOYMENT_BUSINESS_ID,
      gitState: {
        headSha: () => gitSync.headSha(),
        hasCommit: (sha) => gitSync.hasCommit(sha),
      },
      activeCommitSha: async (businessId) => {
        try {
          return (await soulPublications.activeBundle(businessId, soulBundleVerifier))?.commitSha;
        } catch (err) {
          console.error(
            `Soul: could not read active bundle for reconcile (${err instanceof Error ? err.message : String(err)}) — treating as unpublished`
          );
          return undefined;
        }
      },
    });
    gitSync = new GitSyncService(soulPath, gitRemoteUrl, gitCredentialProvider, console, {
      committedTreePublisher: soulPublisher,
      defaultCommitActor: () => SYSTEM_SOUL_COMMIT_ACTOR,
    });
    // A stale/invalid remote (revoked PAT, unreachable host) must never crash-loop boot — fall
    // Business → Soul PUT route) still throws on the same failure so the user sees it there.
    try {
      await gitSync.bootSync();
    } catch (err) {
      console.error(
        `Soul: boot sync with remote failed (${err instanceof Error ? err.message : String(err)}) — continuing with local soul state`
      );
    }

    // Nothing published bundles before this producer existed, and remote-authored commits never
    // Routines/Triggers. Reconcile HEAD into the active bundle at boot. Never fatal, same as above.
    try {
      await soulPublisher.reconcile(DEPLOYMENT_BUSINESS_ID, SOUL_SYNC_COMMIT_ACTOR);
    } catch (err) {
      console.error(
        `Soul: boot reconcile failed (${err instanceof Error ? err.message : String(err)}) — active bundle may lag HEAD until the next sync`
      );
    }

    const soulMigrated = await runSoulMigrations(soulPath, console);
    if (soulMigrated) {
      await gitSync.withSyncPaths("chore(soul): migrate format", ["soul.yaml", "models"]);
    }

    const soulLoader = new SoulLoader(soulPath, console, surfaceRendererRegistry);
    await soulLoader.load();
    // The single ADR-007 write gateway. Every authoring surface writes through this instance, so
    // path building, validation, atomic commit, push, catalog reload and bundle publication happen
    // in exactly one place instead of being re-implemented at each call site.
    const soulWriter = createSoulWriter({
      soulPath,
      signer: await resolveSoulCommitSigner(secretsService),
      logger: console,
      gitSync,
      reload: () => soulLoader.load(),
      publisher: soulPublisher,
      treeReader: soulTreeReader,
    });
    const bundledSkills = await loadBundledSkills(console);
    const disabledBundledSkills = await loadDisabledBundledSkills(soulPath, console);
    // Built-in Skills are authored artifacts, not a hidden overlay: seed them into the Soul repo so
    // they are versioned, inspectable and editable through the product. Never fatal — a Soul that
    // cannot be written still serves the Skills from the read-only bundled overlay.
    try {
      await syncBundledSkillsIntoSoul({
        soulPath,
        bundledSkills,
        disabledBundledSkills,
        soulWriter,
        actor: SOUL_SYNC_COMMIT_ACTOR,
        logger: console,
      });
    } catch (err) {
      console.error(
        `Soul: seeding built-in skills failed (${err instanceof Error ? err.message : String(err)}) — they remain available from the bundled overlay`
      );
    }
    const bundledIntegrations = await loadBundledIntegrations(console);

    // Per-type resource tables can't be created lazily (no `db.collection(type)`):
    await reconcileResourceTables(pool, soulLoader, console);

    const ttlSeconds = Number.parseInt(
      process.env.SESSION_TTL_SECONDS ?? String(DEFAULT_SESSION_TTL_SECONDS),
      10
    );
    const sessionStore = new PgSessionStore(pool, ttlSeconds);
    const userRepo = new PgUserRepo(pool);
    const setupAdminCreator = new PgSetupAdminCreator(pool, DEPLOYMENT_BUSINESS_ID);
    const tokenRepo = new PgTokenRepo(pool);
    const apiClientRepo = new PgApiClientRepo(pool);
    const externalIdentityRepo = new PgExternalIdentityRepo(pool);
    await syncDeploymentRoles(new PgRoleRepo(transactionPort(pool)));
    // authored Role actually resolves through the authority layers (and a Role deleted from Soul is
    // reaped). Reserved bootstrap ids are never touched. See identity/role-reconcile.ts.
    await reconcileSoulRoles(
      new PgRoleRepo(transactionPort(pool)),
      soulLoader,
      DEPLOYMENT_BUSINESS_ID,
      console
    );
    const rateLimiter = new PgRateLimiter(pool);
    const invocationValidator = new TypedOutputValidator(RUN_ARTIFACT_SCHEMAS);
    // Same root the Worker derives, so a blob-backed Run Artifact written by either process is
    // readable by the other. Without it `publishFile` fails with `artifact_blob_unavailable`,
    // which is how a sandboxed Skill command dies before its container ever starts.
    const blobs = createBlobPort(join(resolveDataDir() ?? process.cwd(), "blobs"));
    /** Every Artifact reader is the same service over a different transaction scope. */
    const artifactsOver = (transactions: ConstructorParameters<typeof ArtifactStore>[0]) =>
      new ArtifactService(new ArtifactStore(transactions), invocationValidator, blobs);
    const invocations = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(runTransactions, (transaction) =>
        artifactsOver(ambientTransactionPort(transaction))
      ),
      validator: invocationValidator,
      routineDefinitions: new ActiveRoutineInvocationResolver(soulPublications, soulBundleVerifier),
    });
    const activeSoulBundle = () =>
      soulPublications.activeBundle(DEPLOYMENT_BUSINESS_ID, soulBundleVerifier);
    const routineCatalog = new ActiveRoutineCatalog(activeSoulBundle);
    const scheduleDispatcher = new ScheduleDispatcher({
      activeBundle: activeSoulBundle,
      stateStore: new RoutineScheduleStateStore(pool),
      startRoutine: scheduledRoutineTrigger(invocations),
      countActiveRuns: ({ routineId }) =>
        runStore.countActiveByRoutine({ businessId: DEPLOYMENT_BUSINESS_ID, routineId }),
      supersedeActiveRuns: ({ routineId }) =>
        supersedeRoutineRuns(runStore, runCancel.cancel, routineId),
      businessId: DEPLOYMENT_BUSINESS_ID,
      log: console,
    });
    const events = new EventStore(runTransactions, randomUUID);
    const triggerDefinitions = new ActiveTriggerInvocationResolver(
      soulPublications,
      soulBundleVerifier,
      DEPLOYMENT_BUSINESS_ID
    );
    const webhookTriggerDefinitions = new ActiveWebhookTriggerResolver(
      soulPublications,
      soulBundleVerifier,
      DEPLOYMENT_BUSINESS_ID
    );
    const webhookRawPayloadVault = new PgRawPayloadVault(pool, activeDek.key);
    const eventTriggers = new EventTriggerGateway({
      listTriggers: () => triggerDefinitions.listEventTriggers(),
      startRun: triggerRunStarter(invocations),
      nextEventId: randomUUID,
    });
    const runStore = new RunStore(runTransactions);
    const runEventStore = new RunEventStore(runTransactions);
    const budgetStore = new BudgetStore(runTransactions);
    const runCancel = runCanceller(
      new RunCancellationManager(runStore, new ChildLinkStore(runTransactions))
    );

    const hookExecutor =
      process.env.HOOKS_DISABLED === "true"
        ? undefined
        : createHookExecutor(process.env.DATABASE_URL as string, runtimePoolOptions());

    const llmService = new LlmService();
    const guardrailsService = new GuardrailsService();
    const conversationRepo = new PgConversationRepo(pool);
    const messageRepo = new PgMessageRepo(pool);
    const feedbackRepo = new FeedbackRepo(pool);
    const surfaceArtifactStore = new PgSurfaceArtifactStore(pool);
    const surfaceActionStore = new PgSurfaceActionStore(pool);
    const obsRepo = new PgObsRepo(pool);
    const observabilityService = new ObservabilityService(obsRepo);
    // Built after observability so embedding spend lands in the same table as every other call.
    const embeddingService = new EmbeddingService({
      usage: createEmbeddingUsageSink(observabilityService, () => obsConfig.pricingOverrides),
    });
    const { logRepo, logSink, resourceSampler } = startProcessSamplers(pool);
    const memoryTelemetry = createObservabilityTelemetryPort(observabilityService);
    const { documents: memoryDocuments } = buildMemoryServices({
      pool,
    });
    const kvService = new KvService(new PgKvRepo(pool));
    const taskRepo = new TaskRepo(transactionPort(pool));
    // Sharing a File with a Role resolves that Role live on every read, through the one shared
    // implementation the Tool gate uses. A second answer to "which Roles does this person hold"
    // is how a File stays readable to someone a Role no longer contains.
    const fileAuthorityRepos = {
      roles: new PgRoleRepo(transactionPort(pool)),
      groups: new PgGroupRepo(transactionPort(pool)),
    };
    const fileService = new FileService({
      repo: new PgFileRepo(pool),
      rolesOf: (businessId, principalId) =>
        collectHeldRoleIds(fileAuthorityRepos, businessId, principalId, new Date()),
      blobs,
      newId: () => randomUUID(),
      // Read per upload from the Soul, so an operator turning downscaling on takes effect on the
      // next upload rather than on the next restart.
      imagePolicy: async () => (await readSoulConfig(soulPath)).files ?? {},
    });
    const activityService = new ActivityService(new PgActivityRepo(pool));
    // Audit is separate from activity by design: activity is a UI feed, audit is evidence.
    // Persisted to an append-only ledger the runtime role cannot rewrite (see `audit/repo.ts`).
    const auditRepo = new PgAuditEventRepo(pool);
    const auditService = new AuditService(auditRepo);
    // The emergency stop's own state. Read live on every mutating effect by the guard below, and
    // armed only through the admin-gated routes.
    const killSwitchRepo = new KillSwitchRepo(transactionPort(pool));
    const killSwitches = new KillSwitchService(killSwitchRepo, auditService);
    const mutationGuard = new MutationKillSwitchGuard({
      listEnabled: (businessId) => killSwitchRepo.listEnabled(businessId),
      audit: killSwitches.auditPort(),
    });
    // Stage 3 admin authorization surface. Reuses the same Pg repos and the live authority resolver
    // the gate will later consume, so `explain` runs the one decision function, not a copy. Role
    // *definitions* stay Soul-authored — this service never writes durable Role rows.
    // One resolver, shared. The admin surface's "why was this denied" and the gate's actual
    // decision must read the same grants through the same code, or the explanation describes a
    const authorityLayerResolver = buildApiAuthorityLayerResolver(pool);
    const routeAuthorizer = new LiveRouteAuthorizer(authorityLayerResolver);
    const gateOptions = deploymentGateOptions(() => app.log);
    const operationalCheck = makeAuthorizationCheck(routeAuthorizer, gateOptions);
    const authzAdmin = new AuthzAdminService({
      roles: new PgRoleRepo(transactionPort(pool)),
      groups: new PgGroupRepo(transactionPort(pool)),
      principals: new PgPrincipalRepo(transactionPort(pool)),
      resolver: authorityLayerResolver,
      businessId: DEPLOYMENT_BUSINESS_ID,
      audit: auditService,
      roleNames: () =>
        new Map(
          [...soulLoader.roles.values()].map(
            (role) =>
              [
                role.definition.metadata.id,
                {
                  slug: role.name,
                  ...(role.definition.metadata.displayName === undefined
                    ? {}
                    : { displayName: role.definition.metadata.displayName }),
                },
              ] as const
          )
        ),
    });
    // The ledger's reader. Without it `audit_events` is write-only and the evidence is
    // unreachable outside `psql` — see `audit/routes.ts`.
    const auditReadService = new AuditReadService(auditRepo);
    const obsConfig = parseObservabilityConfig(soulLoader.observabilityConfig);
    const resourceRepoFactory = new PgResourceRepoFactory(pool);
    const counterStore = new PgCounterStore(pool);
    const reconcileResources = () => reconcileResourceTables(pool, soulLoader, console);

    const domainEventEmitter = new EventEmitter();
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL as string });
    await boss.start();

    // caller, so ingestion and unified retrieval never disagree about what's indexed.
    const knowledgeSourceStore = new PgKnowledgeSourceStore(pool);
    const knowledgeIndexStore = new PgKnowledgeIndexStore(pool, embeddingService);

    // The lexical arm of `hybridSearchPages`. Without it `query_knowledge` is vector-only, so an
    // instance with no embedding provider — or with chunks not yet backfilled — answers every
    // question "not found" while the page sits indexed and readable.
    const knowledgeRetrieval = new PageRetrievalService(pool);

    const knowledgeService = new KnowledgeService({
      pages: new PgKnowledgePageRepo(pool),
      chunks: new PgKnowledgeChunkRepo(pool),
      revisions: new PgKnowledgeRevisionRepo(pool),
      spaces: new PgKnowledgeSpaceRepo(pool),
      links: new PgKnowledgeLinksRepo(pool),
      overrides: new PgKnowledgeSpaceOverrideRepo(pool),
      embeddings: embeddingService,
      retrieval: knowledgeRetrieval,
      acl: new PgKnowledgeAclRepo(pool),
      // Without this the Page-ACL surfaces degrade silently rather than fail: `visibility` 404s,
      // every listing badge reads "business", and a move reports no readership change — so the
      // product offers no way to restrict a Page at all.
      readership: new PgKnowledgeSubjectStore(pool),
      enqueueIndex: (pageId) => enqueueIndex(boss, { kind: "page", pageId }).then(() => undefined),
      indexQueueStats: makeIndexQueueStats(boss, pool),
      sourceRetrieval: {
        sources: knowledgeSourceStore,
        index: knowledgeIndexStore,
        live: new CompositeLiveSourceAuthorization([
          new SlackTenantLiveAuthorization(integrationStore, secretsService, externalIdentityRepo),
        ]),
        now: () => new Date(),
      },
    });

    const approvalsRepo = new ApprovalsRepo(pool);
    // registered here rather than in the Worker because its one-use resume token must never leave
    const runResume = new RunResumeGateway(runStore);
    const runWaits = new DurableWaitManager(new WaitStore(runTransactions), runResume);
    const toolApprovals = new ToolApprovalService({ repo: approvalsRepo, waits: runWaits });
    const routineApprovals = new RoutineApprovalService({ repo: approvalsRepo, waits: runWaits });
    const ingressDeliveries = new IngressDeliveriesRepo(pool);
    const integrationThreads = new IntegrationConversationsRepo(pool);
    const integrationEvents = new IntegrationEventsRepo(pool);
    const channelRunDeliveries = new ChannelRunDeliveryStore(runTransactions, () =>
      new Date().toISOString()
    );
    const channelMentionedThreads = new ChannelMentionedThreadStore(runTransactions, () =>
      new Date().toISOString()
    );
    const channelIntegrations = new IntegrationStore(runTransactions);
    // The bind link's HMAC key comes from the secret store, provisioned on first use — never a
    const channelBind = {
      repo: externalIdentityRepo,
      signingKey: channelBindKeyResolver(secretsService),
    };

    // GitHub chat tool family: registered unconditionally (each tool's own effect dispatch fails
    const githubTooling = buildGitHubTooling({
      businessId: DEPLOYMENT_BUSINESS_ID,
      integrations: integrationStore,
      secrets: async () => secretsService,
    });
    const githubEffects = new PgEffectStore(runTransactions);
    const githubTools = buildGitHubTools(DEPLOYMENT_BUSINESS_ID, {
      ...githubTooling,
      effects: githubEffects,
      mutationGuard,
    });

    const slackTooling = buildSlackTooling({
      secrets: async () => secretsService,
      channelRunDelivery: channelRunDeliveries,
    });
    const slackEffects = new PgEffectStore(runTransactions);
    const slackTools = buildSlackTools(DEPLOYMENT_BUSINESS_ID, {
      ...slackTooling,
      effects: slackEffects,
      threads: integrationThreads,
      mentionedThreads: channelMentionedThreads,
      mutationGuard,
    });

    // Google Workspace chat tool family: registered unconditionally (like Slack); each tool's own
    // credential lease fails closed when no Google account is connected.
    const googleTooling = buildGoogleTooling({
      secrets: async () => secretsService,
      // Supplies the OAuth step + connection env so the leased access token refreshes itself before
      // expiry. Read live from the loaded Soul so a reconnect is picked up without an API restart.
      connection: async () => {
        const integration = soulLoader.integrations.get("google");
        const env = integration?.connection?.env;
        const manifest = integration?.manifest;
        if (env === undefined || manifest === undefined) return undefined;
        const step = resolveAuthSteps(manifest).find(
          (candidate): candidate is AuthOAuth2Step => candidate.kind === "oauth2"
        );
        return step === undefined ? undefined : { step, env };
      },
    });
    const googleEffects = new PgEffectStore(runTransactions);
    const googleTools = buildGoogleTools(DEPLOYMENT_BUSINESS_ID, {
      ...googleTooling,
      effects: googleEffects,
      mutationGuard,
    });

    const delegationConversations = new PgConversationStore(pool);
    const childLinks = new ChildLinkAncestryStore(pool);
    // Read at call time: the registry is still being built on the next statement.
    const delegationCatalog = delegationCatalogOf({ getAll: () => toolRegistry.getAll() });
    const agentDelegation = createAgentDelegation({
      businessId: DEPLOYMENT_BUSINESS_ID,
      links: new ChildLinkStore(runTransactions),
      ancestry: childLinks,
      startChildConversation: startChildConversation({
        conversations: conversationRepo,
        store: delegationConversations,
        invocations,
      }),
      conversations: delegationConversations,
      cancelRun: runCancel.cancel,
      catalog: delegationCatalog,
      parentToolNames: (agentId) => delegableToolNames(soulLoader, agentId, toolRegistry.getAll()),
      waits: runWaits,
      newWaitId: randomUUID,
    });
    const runArtifacts = artifactsOver(runTransactions);
    // Beside delegation, sharing its coordinator: an invented helper is bound by the same depth
    // ceiling, the same narrowing-only deadline and the same read-only default as a Soul one.
    const subagentSpawning = createSubagentSpawning({
      businessId: DEPLOYMENT_BUSINESS_ID,
      links: new ChildLinkStore(runTransactions),
      ancestry: childLinks,
      startSubagentRun: startSubagentRun({ invocations }),
      answers: subagentAnswers({ runs: runStore, artifacts: runArtifacts }),
      cancelRun: runCancel.cancel,
      catalog: delegationCatalog,
      parentToolNames: (agentId) => delegableToolNames(soulLoader, agentId, toolRegistry.getAll()),
      waits: runWaits,
      newWaitId: randomUUID,
    });
    // One gate for the whole process: routes and Agent Tools must not diverge on who may read a Page.
    // Local container execution is dev-only; production leaves this absent so the sandbox Tools
    // report that execution is unavailable rather than silently reaching for a Docker socket.
    const sandboxRuntimeImage =
      process.env.NODE_ENV === "production" || process.env.SANDBOX_RUNTIME_IMAGE === undefined
        ? {}
        : { runtimeImage: process.env.SANDBOX_RUNTIME_IMAGE };
    const knowledgePageGate = new PageReadGate(pool);
    // Refusing a taken path is the one bit the gate cannot hide, so every refused write is recorded.
    const knowledgeDenialSink = makeKnowledgeDenialSink(auditService);
    const knowledgeAuthorLabeller = new AuthorLabeller(pool);
    const knowledgeReaderDirectory = new ReaderDirectory(pool);
    const knowledgeSubjectDirectory = new SubjectDirectory(pool);
    const { marketplace: skillMarketplace, skillTools } = composeSkillTools(
      gitSync,
      soulWriter,
      soulLoader,
      llmService,
      bundledSkills,
      disabledBundledSkills
    );
    const networkTools = composeNetworkTools({
      secrets: secretsService,
      soulLoader,
      authorityLayers: authorityLayerResolver,
    });
    // The GitHub Skill documents Tools that are excluded whenever the integration is uninstalled.
    // Hiding it on the same live check keeps `skill_list`/`skill` from advertising a workflow
    // whose every Tool call would be refused.
    const hiddenSkillNames = () =>
      githubDisabledSkillNames({
        integrations: integrationStore,
        businessId: DEPLOYMENT_BUSINESS_ID,
      });
    const toolRegistry = buildToolRegistry({
      memoryDocuments,
      kv: kvService,
      files: fileService,
      knowledge: knowledgeService,
      knowledgePageGate,
      knowledgeDenialSink,
      surfaceComponents: { gitSync, soulWriter, surfaceSupport: surfaceRendererRegistry },
      resources: {
        repoFactory: resourceRepoFactory,
        counterStore,
        soulLoader,
        hookExecutor,
        events: domainEventEmitter,
      },
      resourceTypes: { gitSync, soulWriter, soulLoader, reconcile: reconcileResources },
      agentTools: { gitSync, soulWriter, soulLoader },
      skillTools: { ...skillTools, hiddenSkillNames },
      github: githubTools,
      slack: slackTools,
      google: googleTools,
      network: networkTools,
      tasks: { businessId: DEPLOYMENT_BUSINESS_ID, tasks: taskRepo },
      platform: {
        events: domainEventEmitter,
        soulLoader,
        soulPath,
        gitSync,
        soulWriter,
        bundledSkills,
        disabledBundledSkills,
        hiddenSkillNames,
        triggerRoutine: manualRoutineTrigger(invocations),
        skillCommands: new SkillCommandRunner({
          artifacts: runArtifacts,
          bundle: () => soulPublications.activeBundle(DEPLOYMENT_BUSINESS_ID, soulBundleVerifier),
          ...sandboxRuntimeImage,
        }),
        skillBash: new SkillBashRunner({
          artifacts: runArtifacts,
          bundle: () => soulPublications.activeBundle(DEPLOYMENT_BUSINESS_ID, soulBundleVerifier),
          ...sandboxRuntimeImage,
        }),
        routineCatalog,
        delegateToAgent: agentDelegation.delegate,
        spawnSubagent: subagentSpawning.spawn,
        onRoutinesChanged: async () => {
          await soulLoader.reload();
          // Ticks immediately so a newly-authored/edited schedule is reconciled without waiting up
          await scheduleDispatcher.tick();
        },
        // The Soul write gateway reloads the catalog; the guard pipeline is rebuilt separately
        // because every Turn's Context reads this service, not the published bundle.
        onGuardrailsChanged: async () => {
          guardrailsService.init(soulLoader.guardrailsConfig, app.log);
        },
      },
    });

    // who connects a provider expects its Tools without an API restart.
    const declarativeTools = new DeclarativeToolSync({
      registry: toolRegistry,
      integrations: () => soulLoader.integrations.values(),
      businessId: DEPLOYMENT_BUSINESS_ID,
      effects: slackEffects,
      secrets: async () => secretsService,
      // Manifests are authored from chat, so the destination is untrusted right up to the socket.
      http: new GuardedEgressHttp(new FetchEgressHttp()),
      mutationGuard,
      logger: () => app.log,
    });

    // with, so a worker credential is a key to a Run rather than a principal of its own.
    const conversationStore = new PgConversationStore(pool);
    const internalTurns = {
      host: new InternalTurnHost({
        runs: runStore,
        store: conversationStore,
        agentForRun: agentForRunResolver(soulLoader, runArtifacts),
        // No presentation context: a Run that assembles its own context has no surface, so the
        // Tools that require one are filtered out here rather than refused at dispatch.
        agentTools: (agentName) => {
          const allowed = allowedToolNamesFor(toolRegistry, getDefaultAssistant(agentName ?? ""));
          return (toolRegistry?.getAll() ?? [])
            .filter((tool) => allowed === undefined || allowed.has(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema as Record<string, unknown>,
              ...(tool.tier === undefined ? {} : { tier: tool.tier }),
              ...(tool.mutating === undefined ? {} : { mutating: tool.mutating }),
            }));
        },
        messages: messageRepo,
        subagentContext: new SubagentTurnContextResolver({
          artifacts: runArtifacts,
          toolRegistry,
          guardrails: guardrailsService,
          childLinks,
        }),
        context: new ChatTurnContextResolver({
          artifacts: runArtifacts,
          store: conversationStore,
          soulLoader,
          toolRegistry,
          guardrails: guardrailsService,
          bundledSkills,
          channelDeliveries: channelRunDeliveries,
          childLinks,
          githubStatus: { integrations: integrationStore, businessId: DEPLOYMENT_BUSINESS_ID },
          // Authority layers L1/L2 for the model path, off the same live resolver the Tool gate
          // uses, so `platform.model` is decided by the one decision function rather than a copy.
          // Shadow until there is evidence over real traffic: no role grants `platform.model`
          // yet, so enforcing today would deny every turn a model.
          modelGate: new ModelSelectorGate({
            resolver: authorityLayerResolver,
            mode: modelGateModeFromEnv(),
            log: (event, message) => console.warn(JSON.stringify({ ...event, msg: message })),
          }),
          telemetry: memoryTelemetry,
          files: fileService,
          // The Soul reminder is a disclosure decision, so it is narrowed off the same live
          // resolver the Tool gate uses rather than a copy of the rules.
          authorityLayers: authorityLayerResolver,
          // The same two reads `get_memory` performs, so the reminder and the Tool cannot disagree
          // about what is on file for this person.
          memory: memoryDocuments,
          customInstructions: (userId: string) => readCustomInstructions(kvService, userId),
        }),
        files: fileService,
        tools: buildDelegatedToolDispatch({
          links: childLinks,
          catalog: delegationCatalog,
          registry: toolRegistry,
          artifacts: runArtifacts,
          soulLoader,
          approvals: toolApprovals,
          channelDeliveries: channelRunDeliveries,
          surfaces: apiSurfacePresentation,
          surfaceStore: surfaceArtifactStore,
          surfaceActionStore,
          guardrails: guardrailsService,
          authorityLayers: authorityLayerResolver,
          integrations: integrationStore,
          tokens: principalTokens,
          identities: externalIdentityRepo,
          githubInstallationToken: githubTooling.installationToken,
          transactions: runTransactions,
          logger: { error: (message, error) => app.log.error({ err: error }, message) },
        }),
        approvals: {
          // was minted with — never one the Worker names for itself.
          registerWait: (authority, input) =>
            toolApprovals.registerWait({
              businessId: authority.businessId,
              runId: authority.runId,
              stateKey: input.stateKey,
              approvalId: input.approvalId,
              subject: authority.subject,
            }),
        },
      }),
      deliveries: (log: FastifyBaseLogger) =>
        new IngressDeliveryHost({
          runs: runStore,
          artifacts: runArtifacts,
          store: conversationStore,
          conversations: conversationRepo,
          threads: integrationThreads,
          integrationEvents,
          soulLoader,
          bundled: bundledIntegrations,
          identity: new IngressIdentityResolver({
            users: userRepo,
            log,
            mappings: externalIdentityRepo,
            bind: channelBind,
          }),
          toolRegistry,
          domainEvents: domainEventEmitter,
          eventTriggers,
          // The link is redeemed inside an authenticated web session, so it must point at the
          bindLinkUrl: (token) =>
            `${publicOrigins.current().webOrigin}/link-channel?token=${encodeURIComponent(token)}`,
          log,
        }),
      // without restarting it.
      llmConfig: () => soulLoader.llmConfig,
      pricingOverrides: () => obsConfig.pricingOverrides,
      taskReconcileSignals: async () => {
        const businessName =
          typeof soulLoader.manifest?.businessName === "string"
            ? soulLoader.manifest.businessName
            : undefined;
        const businessDescription =
          typeof soulLoader.manifest?.businessDescription === "string"
            ? soulLoader.manifest.businessDescription
            : undefined;
        const setupComplete = soulLoader.manifest?.setupComplete === true;
        const allUsers = await userRepo.listAll();
        const memberCount = allUsers.filter((u) => u.status !== "disabled").length;
        return { businessName, businessDescription, setupComplete, memberCount };
      },
      // reason: the resume token stays in the process that redeems it.
      routineApprovals: new InternalRoutineApprovalHost({
        runs: runStore,
        db: pool,
        withTransaction: (operation) => withTransaction(pool, operation),
        resume: runResume,
      }),
      childRoutines: new InternalChildRoutineHost({
        runs: runStore,
        links: new ChildLinkStore(runTransactions),
        ancestry: childLinks,
        waits: runWaits,
        start: childRoutineTrigger(invocations),
      }),
      emissions: new InternalEmitHost({
        runs: runStore,
        links: new ChildLinkStore(runTransactions),
        ancestry: childLinks,
        dispatch: (event) => eventTriggers.dispatchInternalEvent(event),
      }),
    };

    const app = await buildApp({
      publicOrigins,
      readiness: pool,
      logSink,
      logRepo,
      resourceRepo: new PgResourceRepo(pool),
      sessionStore,
      userRepo,
      setupAdminCreator,
      userAdminRepo: userRepo,
      passwordWriteRepo: userRepo,
      profileWriteRepo: userRepo,
      userInviteRepo: new PgUserInviteRepo(pool),
      tokenRepo,
      identity: {
        apiClientRepo,
        externalIdentityRepo,
        channelBind,
        channelBindSecrets: secretsService,
      },
      rateLimiter,
      secretsService,
      gitSync,
      soulWriter,
      soulLoader,
      bundledSkills,
      disabledBundledSkills,
      bundledIntegrations,
      slackBind: { integrations: channelIntegrations, businessId: DEPLOYMENT_BUSINESS_ID },
      githubInstall: {
        integrations: channelIntegrations,
        secretsService,
        businessId: DEPLOYMENT_BUSINESS_ID,
        soulRepositories: soulRepositoryStore,
      },
      githubStatus: { integrations: channelIntegrations, businessId: DEPLOYMENT_BUSINESS_ID },
      integrationAuth: { repo: new PgIntegrationAuthRequestRepo(pool), tokens: principalTokens },
      hookExecutor,
      resourceRepoFactory,
      counterStore,
      recordAuthorizer: new LiveRecordAuthorizer(soulLoader, authorityLayerResolver),
      authorityLayers: authorityLayerResolver,
      routeAuthorizer,
      authorizationGate: gateOptions,
      reconcileResources,
      reconcileSoulRoles: async () => {
        await soulLoader.reload();
        await reconcileSoulRoles(
          new PgRoleRepo(transactionPort(pool)),
          soulLoader,
          DEPLOYMENT_BUSINESS_ID,
          console
        );
      },
      domainEventEmitter,
      llmService,
      skillMarketplace,
      triggerCuratorSweep: async () => {
        await boss.send(CURATOR_SWEEP_QUEUE, {});
      },
      guardrailsService,
      conversationRepo,
      messageRepo,
      feedbackRepo,
      surfaceArtifactStore,
      surfaceActionStore,
      memoryDocuments,
      kvService,
      taskStore: taskRepo,
      fileService,
      fileKnowledge: buildFileKnowledgeBridge(pool, boss, DEPLOYMENT_BUSINESS_ID),
      ...buildCurator({
        pool,
        documents: memoryDocuments,
        tasks: taskRepo,
        soul: soulLoader,
        invocations,
        llm: llmService,
        events: domainEventEmitter,
      }),
      knowledgeService,
      knowledgeRetrieval,
      knowledgePageGate,
      knowledgeDenialSink,
      knowledgeAuthorLabeller,
      knowledgeReaderDirectory,
      knowledgeSubjectDirectory,
      toolRegistry,
      declarativeTools,
      activityService,
      auditService,
      auditReadService,
      authzAdmin,
      killSwitches,
      observabilityService,
      observabilityConfig: obsConfig,
      invocations,
      conversationStore,
      runCancel,
      internalTurns,
      approvalsRepo,
      routineApprovals,
      routineCatalog,
      routineDetail: {
        catalog: routineCatalog,
        runs: {
          listByRoutine: async ({ routineId, routineSlug, limit }) => {
            const page = await runStore.list({
              businessId: DEPLOYMENT_BUSINESS_ID,
              limit,
              routineId,
            });
            return page.items.map((run) => ({
              id: run.id,
              routineSlug,
              status: run.status,
              createdAt: run.createdAt,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
            }));
          },
        },
        trigger: manualRoutineTrigger(invocations),
      },
      toolApprovals,
      channels: (log: FastifyBaseLogger) => ({
        store: conversationStore,
        invocations,
        conversations: conversationRepo,
        threads: integrationThreads,
        identity: new IngressIdentityResolver({
          users: userRepo,
          log,
          mappings: externalIdentityRepo,
          bind: channelBind,
        }),
        runDeliveries: channelRunDeliveries,
        toolApprovals,
        surfaceStore: surfaceArtifactStore,
        surfaceActionStore,
        secrets: secretsService,
        soulLoader,
        // redeemed inside an authenticated web session, so it must point at the origin users
        bindLinkUrl: (token) =>
          `${publicOrigins.current().webOrigin}/link-channel?token=${encodeURIComponent(token)}`,
      }),
      runEvents: {
        events: runEventStore,
        runs: runStore,
        waitForNotify: (runId) => runEventNotifyListener.waitForNotify(runId),
        authorize: async (req) => {
          const principal = req.principal;
          if (!principal) return null;
          const operator = await operationalCheck(principal, {
            action: "operations.read",
            resourceType: "operations",
            fallback: "admin",
          });
          return {
            businessId: principal.businessId,
            audiences: operator ? ["participant", "operator"] : ["participant"],
          };
        },
      },
      operationalApi: createRuntimeOperationalApi({
        authorizationCheck: operationalCheck,
        activity: activityService,
        approvals: approvalsRepo,
        toolApprovals,
        runs: createRunReader(runStore, budgetStore, obsRepo),
        healthProbes: [
          postgresProbe(pool),
          queueProbe(boss),
          soulProbe(gitSync),
          soulPublicationProbe(pool),
          llmProbe(llmService, { reachability: modelReachability(llmService) }),
        ],
        // strand the Run, so the attempt fails loudly instead. Tool-call Approvals — the ones
        // this deployment actually produces — are resolved in-process and never reach here.
        enqueueWake: async () => {
          throw new OperationalNotImplementedError(
            "Resuming a Routine-state Approval requires the Routine wake worker, which this " +
              "deployment does not run."
          );
        },
        guardrailsConfig: () => soulLoader.guardrailsConfig,
      }),
      ingress: {
        soulLoader,
        bundled: bundledIntegrations,
        deliveries: ingressDeliveries,
        invoke: integrationInvoker(invocations),
        resolveSecret: (value) => resolveSecretRef(value, secretsService),
      },
      triggerInvoke: {
        resolveTrigger: (slug) => triggerDefinitions.resolveTrigger(slug),
        sink: events,
        startRun: triggerRunStarter(invocations),
        nextEventId: randomUUID,
      },
      hookIngress: {
        resolveTrigger: (provider, trigger) =>
          webhookTriggerDefinitions.resolveTrigger(provider, trigger),
        resolveInvocationTrigger: (slug) => triggerDefinitions.resolveTrigger(slug),
        startRun: triggerRunStarter(invocations),
        ingress: {
          secrets: webhookSecretPort(secretsService),
          vault: webhookRawPayloadVault,
          sink: events,
          nextEventId: randomUUID,
        },
      },
    });

    registerSoulPublicationRoutes(
      app,
      {
        store: new PgSoulPublicationStore(runTransactions),
        coordinator: soulPublications,
        bundleStore: new PgBundleStore(runTransactions),
        verifier: soulBundleVerifier,
        audit: auditService,
        logger: console,
        businessId: DEPLOYMENT_BUSINESS_ID,
        telemetry: createObservabilityTelemetryPort(observabilityService),
      },
      makeRequireAuth({
        store: sessionStore,
        userRepo,
        tokenRepo,
        apiClientRepo,
      }),
      makeRequireAuthorization(routeAuthorizer, gateOptions)
    );

    // Init after buildApp so fallback events log through Fastify's Pino logger.
    declarativeTools.sync();
    // A malformed `soul.yaml#llm` must not take down authentication, the UI and every unrelated
    // feature. The reload path has always degraded to "LLM disabled" on exactly this error; cold
    // boot used to fall through to the boot-wide `process.exit(1)` instead.
    try {
      await llmService.init(soulLoader.llmConfig, secretsService, app.log);
      await embeddingService.init(soulLoader.llmConfig, secretsService, app.log);
    } catch (err) {
      app.log.error(
        `[llm] invalid llm config at boot, continuing with LLM features disabled — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    guardrailsService.init(soulLoader.guardrailsConfig, app.log);
    registerLlmReload(
      gitSync,
      soulLoader,
      llmService,
      embeddingService,
      secretsService,
      app.log,
      () => knowledgeService.runReindexIfPending().then(() => undefined)
    );
    // A dimension change made while this process was down leaves every stored vector at a width
    // exact-match vector search can never return, and the in-memory flag cannot see across a
    // restart. Detached: a full re-index must not hold up serving traffic.
    void knowledgeService.runReindexIfPending().catch((err: unknown) => {
      app.log.error(
        `[knowledge] boot re-index check failed — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
    registerGuardrailsReload(gitSync, soulLoader, guardrailsService, app.log);
    registerResourceReconcile(gitSync, soulLoader, pool, app.log);
    registerSoulRoleReconcile(
      gitSync,
      soulLoader,
      new PgRoleRepo(transactionPort(pool)),
      DEPLOYMENT_BUSINESS_ID,
      app.log
    );
    logEnvironmentStatus(app.log);
    // Before the wizard, and independent of it: a deployment that never opens the wizard still
    // accepts Runs, so the Worker's and Integration Worker's credentials cannot wait on a human
    await provisionWorkerCredential(apiClientRepo, process.env, app.log);
    await provisionIntegrationWorkerCredential(apiClientRepo, process.env, app.log);
    await bootstrapFromEnv({
      userRepo,
      setupAdminCreator,
      secretsService,
      soulPath,
      log: app.log,
    });

    const soulSyncInterval = registerSoulSync(gitSync, gitRemoteUrl, {
      activity: activityService,
      soulLoader,
      log: app.log,
      reconcile: () => soulPublisher.reconcile(DEPLOYMENT_BUSINESS_ID, SOUL_SYNC_COMMIT_ACTOR),
    });
    await registerScheduleDispatch(boss, scheduleDispatcher, { log: app.log });
    await registerCuratorSweepSchedule(boss);
    await registerObsPruneSchedule(boss, obsConfig.retentionDays * 24 * 60 * 60 * 1000);
    // Every Soul commit publishes a bundle, so this table grows for the life of the deployment.
    await registerSoulBundlePruneSchedule(boss, bundleRetentionMs(process.env));
    await registerSpendAlertSchedule(boss, obsConfig.spendAlertUsd);
    await registerKnowledgeIndexing(boss, {
      service: knowledgeService,
      loadConversationText: async (conversationId) => {
        const { items } = await messageRepo.listByConversation(conversationId, 1000);
        const text = items
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .filter((c) => c.length > 0)
          .join("\n\n");
        return text.trim().length > 0
          ? { title: `Conversation ${conversationId}`, content: text }
          : null;
      },
      activity: activityService,
    });
    await registerEmbeddingBackfill(boss, { db: pool, embeddings: embeddingService, log: app.log });
    subscribeKnowledgeIndexing(domainEventEmitter, boss);
    subscribeActivityLogging(domainEventEmitter, activityService);
    const stopDelivery = await startDelivery(
      pool,
      hookExecutor,
      domainEventEmitter,
      app.log,
      eventTriggers
    );
    // the token resolves — the default path loads nothing extra.
    let metricsSink: OtlpMetricsExporter | undefined;
    let tracesSink: OtlpTracesExporter | undefined;
    if (obsConfig.enabled && obsConfig.otlp) {
      const ref = obsConfig.otlp.token;
      const token = ref.startsWith("env://")
        ? process.env[ref.slice(6)]
        : await secretsService.get(ref).catch(() => undefined);
      if (token) {
        const target = {
          endpoint: obsConfig.otlp.endpoint,
          instanceId: obsConfig.otlp.instanceId,
          token,
        };
        metricsSink = new OtlpMetricsExporter(target);
        metricsSink.start();
        tracesSink = new OtlpTracesExporter(target);
        tracesSink.start();
        console.info("[observability] OTLP metrics + traces export enabled");
      } else {
        console.warn("[observability] OTLP enabled but token unresolved — export disabled");
      }
    }
    // model was added in Settings); the built-in price map + config overrides are the fallback.
    subscribeObservability(domainEventEmitter, observabilityService, {
      pricingOverrides: obsConfig.pricingOverrides,
      metrics: metricsSink,
      traces: tracesSink,
      captureContent: obsConfig.captureContent,
    });
    const drainSoulPublications = async (consumer: string, max = 10): Promise<void> => {
      const outcomes = await soulPublications.drain(consumer, max);
      for (const outcome of outcomes) {
        metricsSink?.recordSoulPublication?.({
          status: outcome.status,
          stage: outcome.stage,
          latencyMs: outcome.latencyMs,
        });
      }
    };
    await drainSoulPublications("api.soul-publication.boot", 100).catch((err) => {
      app.log.error(
        `Soul publication boot drain failed — ${err instanceof Error ? err.message : String(err)}`
      );
    });
    let soulDrainRunning = false;
    const soulPublicationDrainInterval = setInterval(() => {
      if (soulDrainRunning) return;
      soulDrainRunning = true;
      void drainSoulPublications("api.soul-publication.loop")
        .catch((err) => {
          app.log.error(
            `Soul publication drain failed — ${err instanceof Error ? err.message : String(err)}`
          );
        })
        .finally(() => {
          soulDrainRunning = false;
        });
    }, 5_000);
    soulPublicationDrainInterval.unref?.();
    await registerConnectorSync(boss, {
      registry: buildDefaultRegistry(),
      state: new PgConnectorStateRepo(pool),
      service: knowledgeService,
      activity: activityService,
    });
    await registerSlackKnowledgeSync(boss, {
      integrations: integrationStore,
      secrets: secretsService,
      checkpoints: new PgSlackKnowledgeCheckpointStore(pool),
      sink: new PgKnowledgeEmissionSink(knowledgeSourceStore, knowledgeIndexStore),
      identity: new ExternalLinkKnowledgeIdentityMap(externalIdentityRepo),
      activity: activityService,
    });

    app.listen({ port, host: "0.0.0.0" }, (err) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
    });

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info(`Received ${signal} — shutting down gracefully`);
      // Watchdog: never let a hung dependency (e.g. pg-boss waiting on jobs) keep the process
      const force = setTimeout(() => {
        app.log.error("Shutdown timed out after 5s — forcing exit");
        process.exit(1);
      }, 5000);
      force.unref();
      try {
        if (soulSyncInterval) clearInterval(soulSyncInterval);
        stopDelivery();
        clearInterval(soulPublicationDrainInterval);
        await app.close();
        await boss.stop({ graceful: false });
        await metricsSink?.flush();
        metricsSink?.stop();
        await tracesSink?.flush();
        tracesSink?.stop();
        await hookExecutor?.close();
        await resourceSampler.stop();
        await logSink.stop();
        await runEventNotifyListener.close();
        await pool.end();
      } catch (err) {
        app.log.error(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        // so the error explaining a failed shutdown is not the one record this feature loses; if
        await resourceSampler.stop().catch(() => {});
        await logSink.stop().catch(() => {});
      }
      clearTimeout(force);
      process.exit(0);
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        void shutdown(signal);
      });
    }
  } catch (error) {
    console.error(`❌ Boot failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

boot();
