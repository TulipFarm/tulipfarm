import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { GuardrailsService } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { EmbeddingService, LlmService } from "@tulipfarm/llm";
import {
  BatchingLogSink,
  PgResourceWriter,
  processResourceProbe,
  ResourceSampler,
} from "@tulipfarm/observability";
import {
  ArtifactService,
  DurableInvocationGateway,
  DurableWaitManager,
  PgDurableInvocationStore,
  RunCancellationManager,
  RunResumeGateway,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { INVOCATION_REQUEST_SCHEMAS } from "@tulipfarm/schema";
import {
  loadEncryptionKeys,
  loadOrProvisionActiveDek,
  PgDekRepo,
  PgSecretRepo,
  SecretsService,
} from "@tulipfarm/secrets";
import {
  type CommitActor,
  type CredentialProvider,
  compileExecutionBundle,
  GitSoulTreeReader,
  GitSyncService,
  PgBundleStore,
  resolveSoulPath,
  runSoulMigrations,
  SoulLoader,
  SoulPublicationCoordinator,
  SoulPublisher,
} from "@tulipfarm/soul";
import {
  ArtifactStore,
  ChannelMentionedThreadStore,
  ChannelRunDeliveryStore,
  ChildLinkStore,
  EventStore,
  IntegrationStore,
  PgGroupRepo,
  PgPrincipalRepo,
  PgRoleRepo,
  PgSoulPublicationStore,
  RunEventStore,
  RunStore,
  SoulRepositoryStore,
  WaitStore,
} from "@tulipfarm/storage";
import { CompositeToolEntitlement, PgEffectStore } from "@tulipfarm/tool-broker";
import { config } from "dotenv";
import type { FastifyBaseLogger } from "fastify";
import { PgBoss } from "pg-boss";
import { subscribeActivityLogging } from "./activity/events";
import { PgActivityRepo } from "./activity/repo";
import { ActivityService } from "./activity/service";
import { type HealthProbe, llmProbe, postgresProbe, queueProbe, soulProbe } from "./admin/health";
import { OperationalNotImplementedError } from "./admin/routes";
import { createRunReader } from "./admin/run-reader";
import { createRuntimeOperationalApi } from "./admin/runtime";
import { buildApp } from "./app";
import { RoutineApprovalService } from "./approvals/routine-approvals";
import { ApprovalsRepo } from "./approvals/runtime-repo";
import { ToolApprovalService } from "./approvals/tool-approvals";
import { AuditReadService } from "./audit/read-service";
import { PgAuditEventRepo } from "./audit/repo";
import { AuditService } from "./audit/service";
import { PgTokenRepo } from "./auth/api-tokens";
import { PgUserInviteRepo } from "./auth/invites";
import { makeRequireAuth } from "./auth/middleware";
import { DEFAULT_SESSION_TTL_SECONDS, PgSessionStore } from "./auth/session-store";
import { PgUserRepo } from "./auth/users";
import { AuthzAdminService } from "./authz/service";
import { PgConversationRepo } from "./chat/conversations";
import { PgMessageRepo } from "./chat/messages";
import { PgConversationStore } from "./conversations/store.pg";
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
import { registerGuardrailsReload } from "./guardrails/reload";
import { createHookExecutor } from "./hooks/executor";
import { PgRawPayloadVault } from "./hooks/raw-payload-vault";
import { webhookSecretPort } from "./hooks/secret-port";
import { PgApiClientRepo } from "./identity/api-clients";
import { buildLiveAuthorityLayerResolver } from "./identity/authority-layers";
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
import { PgIntegrationAuthRequestRepo } from "./integrations/auth-broker";
import { resolveSecretRef } from "./integrations/connection-env";
import { PgPrincipalProviderTokenRepo } from "./integrations/principal-tokens";
import { CredentialResolver } from "./internal/credential-mode";
import { IngressDeliveryHost } from "./internal/delivery-host";
import { GitHubEntitlementPort, HttpGitHubPermissionApi } from "./internal/github-entitlement";
import { InternalRoutineApprovalHost } from "./internal/routine-approval-host";
import { RegistryToolDispatcher } from "./internal/tool-dispatch";
import { LiveToolGate } from "./internal/tool-gate";
import { ChatTurnContextResolver } from "./internal/turn-context";
import { InternalTurnHost } from "./internal/turn-host";
import { PgKnowledgeChunkRepo } from "./knowledge/chunks-repo";
import { buildDefaultRegistry } from "./knowledge/connectors/registry";
import { PgConnectorStateRepo } from "./knowledge/connectors/state-repo";
import { registerConnectorSync } from "./knowledge/connectors/sync";
import { registerEmbeddingBackfill } from "./knowledge/embedding-backfill";
import { subscribeKnowledgeIndexing } from "./knowledge/events";
import { enqueueIndex, makeIndexQueueStats, registerKnowledgeIndexing } from "./knowledge/indexing";
import { PgKnowledgeLinksRepo } from "./knowledge/links-repo";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./knowledge/repo";
import { KnowledgeService } from "./knowledge/service";
import { PgKnowledgeSpaceOverrideRepo } from "./knowledge/space-overrides-repo";
import { PgKnowledgeSpaceRepo } from "./knowledge/spaces-repo";
import { PgSlackKnowledgeCheckpointStore } from "./knowledge-sources/checkpoint-store";
import { PgConfluenceKnowledgeCheckpointStore } from "./knowledge-sources/confluence-checkpoint-store";
import { registerConfluenceKnowledgeSync } from "./knowledge-sources/confluence-sync-schedule";
import { PgKnowledgeEmissionSink } from "./knowledge-sources/emission-sink";
import { PgKnowledgeIndexStore } from "./knowledge-sources/index-store";
import { registerK3KnowledgeSync } from "./knowledge-sources/k3-sync-schedule";
import {
  CompositeLiveSourceAuthorization,
  GoogleDriveTenantLiveAuthorization,
  SlackTenantLiveAuthorization,
} from "./knowledge-sources/live-authorization";
import { registerSlackKnowledgeSync } from "./knowledge-sources/slack-sync-schedule";
import { PgKnowledgeSourceStore } from "./knowledge-sources/source-store";
import { PgProviderKnowledgeCheckpointStore } from "./knowledge-sources/sync-checkpoint-store";
import { PgKvRepo } from "./kv/repo";
import { KvService } from "./kv/service";
import { registerLlmReload } from "./llm-reload";
import { LlmContradictionJudge } from "./memory/contradiction-judge";
import { EngineMemoryRepo } from "./memory/engine-repo";
import { PgMemoryEpisodeStore } from "./memory/episode-store";
import { MemoryExtractionService } from "./memory/extraction-service";
import { LlmMemoryExtractor } from "./memory/extractor";
import { MemoryLifecycleService } from "./memory/lifecycle-service";
import { MemoryRecallService } from "./memory/recall-service";
import { MemoryService } from "./memory/service";
import { parseObservabilityConfig } from "./observability/config";
import { subscribeObservability } from "./observability/events";
import { PgLogRepo } from "./observability/log-repo";
import { OtlpMetricsExporter } from "./observability/metrics";
import { registerObsPruneSchedule } from "./observability/prune-schedule";
import { PgObsRepo } from "./observability/repo";
import { PgResourceRepo } from "./observability/resource-repo";
import { ObservabilityService } from "./observability/service";
import { createObservabilityTelemetryPort } from "./observability/telemetry-port";
import { OtlpTracesExporter } from "./observability/traces";
import { runPgMigrations } from "./pg-migrate";
import { PgRateLimiter } from "./rate-limit";
import { LiveRecordAuthorizer } from "./resources/authorize";
import { reconcileResourceTables, registerResourceReconcile } from "./resources/reconcile";
import { PgCounterStore, PgResourceRepoFactory } from "./resources/repo";
import { ActiveRoutineCatalog } from "./routines/catalog";
import { runCanceller } from "./runs/cancel";
import {
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
import { ScheduleDispatcher } from "./schedule/dispatcher";
import { registerScheduleDispatch } from "./schedule/register";
import { RoutineScheduleStateStore } from "./schedule/state-store";
import { bootstrapFromEnv } from "./setup/bootstrap";
import {
  assertNoOrphanedDeks,
  type BootstrapSecretsResult,
  bootstrapSecrets,
} from "./setup/bootstrap-secrets";
import { PgSetupAdminCreator } from "./setup/first-admin";
import { readSoulConfig, SOUL_GIT_CREDENTIAL_KEY } from "./setup/soul-config";
import {
  provisionIntegrationWorkerCredential,
  provisionWorkerCredential,
} from "./setup/worker-credential";
import { createGitHubSoulCredentialProvider } from "./soul/github-repo-credential";
import { loadBundledIntegrations } from "./soul/integrations/bundled";
import { registerSoulPublicationRoutes } from "./soul/publication-routes";
import { loadBundledSkills, loadDisabledBundledSkills } from "./soul/skills/bundled";
import { registerSoulSync } from "./soul-sync";
import { PgSurfaceActionStore } from "./surfaces/action-store";
import { PgSurfaceArtifactStore } from "./surfaces/artifact-store";
import { surfaceRendererRegistry } from "./surfaces/renderer-registry";
import { FetchEgressHttp } from "./tools/declarative/http";
import { DeclarativeToolSync } from "./tools/declarative/sync";
import { buildGitHubTooling } from "./tools/github/compose";
import { buildGitHubTools } from "./tools/github/tools";
import { buildToolRegistry } from "./tools/setup";
import { buildSlackTooling } from "./tools/slack/compose";
import { buildSlackTools } from "./tools/slack/tools";
import { ensureEmbeddingIndexes } from "./vector-search";

// Load .env.local (symlinked from root by setup script)
config({ path: ".env.local" });

// Fill any bootstrap secret the operator did not supply, from the data volume or fresh
// randomness, so the shipped compose file needs no `.env` at all. Runs before
// validateEnvironment, which requires all three to be present.
const secretsBootstrap = ((): BootstrapSecretsResult => {
  try {
    return bootstrapSecrets();
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
})();

validateEnvironment();

const port = Number.parseInt(process.env.PORT || "4010", 10);
// Fallback actor for genuinely system-initiated Soul commits (format migrations, tool writes with
// no request actor). Deliberately synthetic so the activation ledger never mistakes it for a user.
const SYSTEM_SOUL_COMMIT_ACTOR: CommitActor = {
  principalId: "service:tulipfarm-system",
  name: "TulipFarm (system)",
  email: "",
};
// Attribution for reconciliation publications — HEAD that moved by boot or remote sync, not by a
// local user write — so a GitHub author's change is not credited to the API.
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

function numberFrom(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function dateMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function soulPublicationProbe(database: Queryable): HealthProbe {
  return {
    component: "soul-publication",
    async check() {
      const result = await database.query(
        `
          WITH stats AS (
            SELECT
              COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_lettered_count,
              MAX(publication_sequence) AS newest_sequence
            FROM soul_publications
            WHERE business_id = $1
          ),
          newest AS (
            SELECT created_at, publication_sequence
            FROM soul_publications
            WHERE business_id = $1
            ORDER BY publication_sequence DESC
            LIMIT 1
          ),
          active_publication AS (
            SELECT p.created_at, p.publication_sequence
            FROM soul_active_bundles active
            JOIN soul_publications p
              ON p.business_id = active.business_id
             AND p.digest = active.digest
            WHERE active.business_id = $1
            ORDER BY p.publication_sequence DESC
            LIMIT 1
          )
          SELECT
            stats.dead_lettered_count,
            stats.newest_sequence,
            newest.created_at AS newest_created_at,
            newest.publication_sequence AS newest_publication_sequence,
            active_publication.created_at AS active_created_at,
            active_publication.publication_sequence AS active_publication_sequence
          FROM stats
          LEFT JOIN newest ON true
          LEFT JOIN active_publication ON true
        `,
        [DEPLOYMENT_BUSINESS_ID]
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      const deadLetteredCount = numberFrom(row?.dead_lettered_count);
      const newestSequence = numberFrom(row?.newest_publication_sequence);
      const activeSequence = numberFrom(row?.active_publication_sequence);
      const newestCreatedMs = dateMs(row?.newest_created_at);
      const activeCreatedMs = dateMs(row?.active_created_at);
      const activeLagMs =
        newestCreatedMs !== undefined && activeCreatedMs !== undefined
          ? Math.max(0, newestCreatedMs - activeCreatedMs)
          : undefined;

      if (newestSequence === 0) {
        return { status: "degraded", detail: "no Soul publication has been recorded" };
      }
      if (activeSequence === 0) {
        return {
          status: "degraded",
          detail: `dead-lettered ${deadLetteredCount}, no active Soul bundle`,
        };
      }
      const detail = `dead-lettered ${deadLetteredCount}, active lag ${activeLagMs ?? 0}ms`;
      if (deadLetteredCount > 0 || activeSequence < newestSequence) {
        return { status: "degraded", detail };
      }
      return { status: "ok", detail };
    },
  };
}

async function boot() {
  try {
    const migrationPool = await connectPg();
    await runPgMigrations(migrationPool);
    // After migrations, on the owner pool (which has no statement timeout): an ANN index left
    // invalid by an interrupted build is invisible to the planner but still costs every write.
    await ensureEmbeddingIndexes(migrationPool, (msg) => console.log(msg));
    const pool = await startRuntimePool(migrationPool);
    /**
     * One instance, shared by the two halves of D7's personal-credential protocol: the connect
     * route that seals a credential and the resolver that decides a call needs one. They are a
     * protocol, not two features — a resolver that denies with "connect it from Settings" while
     * the connect route is unwired is a dead end for the person reading it, so neither may be
     * configured without the other.
     */
    const principalTokens = new PgPrincipalProviderTokenRepo(pool);

    // Second half of the key-loss guard: a KEK invented this boot against a database that
    // already holds wrapped DEKs means the real key was lost, not that this is a first boot.
    await assertNoOrphanedDeks((sql) => pool.query(sql), secretsBootstrap);

    const secretRepo = new PgSecretRepo(pool);
    const dekRepo = new PgDekRepo(pool);
    const encryptionKeys = loadEncryptionKeys();
    // Fail-fast boot canary: unwrap the active DEK under the env KEK (auto-provisioning one on
    // first boot to preserve zero-setup) and verify its canary. A wrong/missing key or corrupt
    // wrap throws KeyManagerError → the catch below logs and exits 1, rather than failing later at
    // first secret access. Pre-cutover rows must already have been backfilled to the active DEK.
    const activeDek = await loadOrProvisionActiveDek(dekRepo, encryptionKeys);
    const secretsService = new SecretsService(secretRepo, activeDek);

    // env.ts guarantees exactly one of SOUL_PATH/SOUL_ROOT is set. SOUL_PATH is the legacy flat
    // single-tenant checkout (local dev always uses it); SOUL_ROOT is the hosted/production
    // per-business layout (`resolveSoulPath` -> `<root>/<businessId>/soul`), authenticated via a
    // GitHub App installation token instead of a static PAT.
    const integrationStore = new IntegrationStore(transactionPort(pool));
    const soulRepositoryStore = new SoulRepositoryStore(transactionPort(pool));

    let soulPath: string;
    let gitRemoteUrl: string | undefined;
    let gitCredentialProvider: CredentialProvider;

    if (process.env.SOUL_PATH) {
      soulPath = process.env.SOUL_PATH;
      // SOUL_GIT_REMOTE_URL/SOUL_GIT_CREDENTIAL only seed the very first boot. Once Settings →
      // Soul persists a remote (soul.yaml's gitRemoteUrl + the "soul-git-credential" secret),
      // that takes over — otherwise a restart would forget a remote configured after boot.
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
    const soulPublisher = new SoulPublisher({
      treeReader: new GitSoulTreeReader(soulPath),
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
    // back to whatever soul state is already on disk and keep serving. `configureRemote` (the
    // Business → Soul PUT route) still throws on the same failure so the user sees it there.
    try {
      await gitSync.bootSync();
    } catch (err) {
      console.error(
        `Soul: boot sync with remote failed (${err instanceof Error ? err.message : String(err)}) — continuing with local soul state`
      );
    }

    // Nothing published bundles before this producer existed, and remote-authored commits never
    // fire the local commit hook — both leave `soul_active_bundles` behind git HEAD, with dead
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
    const bundledSkills = await loadBundledSkills(console);
    const disabledBundledSkills = await loadDisabledBundledSkills(soulPath, console);
    const bundledIntegrations = await loadBundledIntegrations(console);

    // Per-type resource tables can't be created lazily (no `db.collection(type)`):
    // materialise them for every loaded soul type before serving.
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
    // Project authored Soul Roles into durable rows after the bootstrap roles are seeded, so an
    // authored Role actually resolves through the authority layers (and a Role deleted from Soul is
    // reaped). Reserved bootstrap ids are never touched. See identity/role-reconcile.ts.
    await reconcileSoulRoles(
      new PgRoleRepo(transactionPort(pool)),
      soulLoader,
      DEPLOYMENT_BUSINESS_ID,
      console
    );
    const rateLimiter = new PgRateLimiter(pool);
    // One validator for the request boundary: the gateway rejects an unregistered schema reference
    // before minting a Run, and the same instance re-validates on publish and on every later read.
    const invocationValidator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
    const invocations = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(
        runTransactions,
        (transaction) =>
          new ArtifactService(
            new ArtifactStore(ambientTransactionPort(transaction)),
            invocationValidator
          )
      ),
      validator: invocationValidator,
      routineDefinitions: new ActiveRoutineInvocationResolver(soulPublications, soulBundleVerifier),
    });
    // Ticks every `cron`/`interval`/`datetime` `x-triggers` entry across active Routines and starts
    // a Run for whatever's due. Lives here (not the Worker) since only this process holds the live
    // Soul checkout. See docs/plans/2026-08-08-routine-cron-scheduler-design.md.
    const scheduleDispatcher = new ScheduleDispatcher({
      soulLoader,
      stateStore: new RoutineScheduleStateStore(pool),
      startRoutine: scheduledRoutineTrigger(invocations),
      businessId: DEPLOYMENT_BUSINESS_ID,
      log: console,
    });
    // Canonical event intake/outbox for Trigger invocation, shared in shape (not process) with the
    // Worker's own `EventStore` — this is the first API-side instantiation of it.
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
    // Same DEK `SecretsService` encrypts stored secrets with — no separate key material.
    const webhookRawPayloadVault = new PgRawPayloadVault(pool, activeDek.key);
    // Read side of the same canonical `runs` / `run_states` tables the gateway writes.
    const runStore = new RunStore(runTransactions);
    const runEventStore = new RunEventStore(runTransactions);
    // Stopping a turn is cancelling its Run: the process executing it observes the cancellation and
    // halts, so a participant can stop a turn no request handler here is holding.
    const runCancel = runCanceller(
      new RunCancellationManager(runStore, new ChildLinkStore(runTransactions))
    );

    const hookExecutor =
      process.env.HOOKS_DISABLED === "true"
        ? undefined
        : createHookExecutor(process.env.DATABASE_URL as string, runtimePoolOptions());

    const llmService = new LlmService();
    const guardrailsService = new GuardrailsService();
    const embeddingService = new EmbeddingService();
    const conversationRepo = new PgConversationRepo(pool);
    const messageRepo = new PgMessageRepo(pool);
    const feedbackRepo = new FeedbackRepo(pool);
    const surfaceArtifactStore = new PgSurfaceArtifactStore(pool);
    const surfaceActionStore = new PgSurfaceActionStore(pool);
    const observabilityService = new ObservabilityService(new PgObsRepo(pool));
    const logRepo = new PgLogRepo(pool);
    // Tees error/fatal log records into `log_event` so the observability UI can show them. Started
    // here (not in buildApp) because the flush timer belongs to the process, not to the app object.
    const logSink = new BatchingLogSink({ service: "api", writer: logRepo });
    logSink.start();
    // Fixed-cadence CPU/RSS samples for the observability dashboard. Started here for the same
    // reason as the log sink: the interval belongs to the process, not to the app object.
    const resourceSampler = new ResourceSampler({
      service: "api",
      instance: `${hostname()}:${process.pid}`,
      probe: processResourceProbe(process),
      writer: new PgResourceWriter(pool),
    });
    resourceSampler.start();
    const memoryTelemetry = createObservabilityTelemetryPort(observabilityService);
    // `embeddingService` is initialized later (it needs the Soul LLM config), and both memory
    // consumers only call it at request time — so passing it here wires the dense recall arm
    // without forcing the boot order to change.
    const memoryService = new MemoryService(
      new EngineMemoryRepo(pool, undefined, embeddingService, memoryTelemetry)
    );
    const memoryRecallService = new MemoryRecallService(pool, embeddingService, memoryTelemetry);
    const memoryEpisodeStore = new PgMemoryEpisodeStore(
      pool,
      embeddingService,
      undefined,
      memoryTelemetry
    );
    const memoryLifecycleService = new MemoryLifecycleService(
      pool,
      () => new Date(),
      embeddingService,
      memoryTelemetry
    );
    const memoryExtractionService = new MemoryExtractionService(
      pool,
      new LlmMemoryExtractor(() => llmService.effortModel("fast")),
      guardrailsService,
      embeddingService,
      () => new Date(),
      new LlmContradictionJudge(() => llmService.effortModel("fast")),
      memoryEpisodeStore,
      memoryTelemetry
    );
    const kvService = new KvService(new PgKvRepo(pool));
    const activityService = new ActivityService(new PgActivityRepo(pool));
    // Audit is separate from activity by design: activity is a UI feed, audit is evidence.
    // Persisted to an append-only ledger the runtime role cannot rewrite (see `audit/repo.ts`).
    const auditRepo = new PgAuditEventRepo(pool);
    const auditService = new AuditService(auditRepo);
    // Stage 3 admin authorization surface. Reuses the same Pg repos and the live authority resolver
    // the gate will later consume, so `explain` runs the one decision function, not a copy. Role
    // *definitions* stay Soul-authored — this service never writes durable Role rows.
    // One resolver, shared. The admin surface's "why was this denied" and the gate's actual
    // decision must read the same grants through the same code, or the explanation describes a
    // deployment that does not exist.
    const authorityLayerResolver = buildLiveAuthorityLayerResolver(pool);
    const authzAdmin = new AuthzAdminService({
      roles: new PgRoleRepo(transactionPort(pool)),
      groups: new PgGroupRepo(transactionPort(pool)),
      principals: new PgPrincipalRepo(transactionPort(pool)),
      resolver: authorityLayerResolver,
      businessId: DEPLOYMENT_BUSINESS_ID,
      audit: auditService,
      // Names come from the Soul artifacts themselves, so a level is called what its author called
      // it rather than by the UUID its durable row is keyed on. `compileSoulRole` derives the row
      // id from `metadata.id`, so this map keys on the same value the roles repo returns.
      roleNames: () =>
        new Map(
          [...soulLoader.roles.values()].map(
            (role) =>
              [
                role.definition.metadata.id,
                {
                  // `role.name` is the artifact directory the loader keyed on, which is exactly the
                  // slug the delete route addresses. Re-deriving it from the display name would
                  // break the moment a level was named something that slugifies differently.
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

    // pg-boss starts before buildApp so the knowledge service's async-index callback can enqueue.
    const domainEventEmitter = new EventEmitter();
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL as string });
    await boss.start();

    // Shared with registerSlackKnowledgeSync below — one store instance per process, not one per
    // caller, so ingestion and unified retrieval never disagree about what's indexed.
    const knowledgeSourceStore = new PgKnowledgeSourceStore(pool);
    const knowledgeIndexStore = new PgKnowledgeIndexStore(pool, embeddingService);

    const knowledgeService = new KnowledgeService({
      pages: new PgKnowledgePageRepo(pool),
      chunks: new PgKnowledgeChunkRepo(pool),
      revisions: new PgKnowledgeRevisionRepo(pool),
      spaces: new PgKnowledgeSpaceRepo(pool),
      links: new PgKnowledgeLinksRepo(pool),
      overrides: new PgKnowledgeSpaceOverrideRepo(pool),
      embeddings: embeddingService,
      enqueueIndex: (pageId) => enqueueIndex(boss, { kind: "page", pageId }).then(() => undefined),
      indexQueueStats: makeIndexQueueStats(boss, pool),
      sourceRetrieval: {
        sources: knowledgeSourceStore,
        index: knowledgeIndexStore,
        live: new CompositeLiveSourceAuthorization([
          new SlackTenantLiveAuthorization(integrationStore, secretsService, externalIdentityRepo),
          new GoogleDriveTenantLiveAuthorization(soulLoader, secretsService, externalIdentityRepo),
        ]),
        now: () => new Date(),
      },
    });

    const approvalsRepo = new ApprovalsRepo(pool);
    // A Worker-executed turn asks for approval by parking its Run on a durable wait. The wait is
    // registered here rather than in the Worker because its one-use resume token must never leave
    // the process that will redeem it — the Worker only ever learns the wait's id.
    const runResume = new RunResumeGateway(runStore);
    const runWaits = new DurableWaitManager(new WaitStore(runTransactions), runResume);
    const toolApprovals = new ToolApprovalService({ repo: approvalsRepo, waits: runWaits });
    // The Routine side of the same surface: a State names approver roles rather than a person, so
    // the decision is authorized by the roles the deciding principal holds.
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
    // constant in the image, which every deployment would share.
    const channelBind = {
      repo: externalIdentityRepo,
      signingKey: channelBindKeyResolver(secretsService),
    };

    // GitHub chat tool family: registered unconditionally (each tool's own effect dispatch fails
    // closed with no installation), visibility gated live per turn on install status elsewhere
    // (chat/turn-helpers.ts) rather than here — see docs/plans/2026-08-07-github-chat-tool-access.md.
    const githubTooling = buildGitHubTooling({
      businessId: DEPLOYMENT_BUSINESS_ID,
      integrations: integrationStore,
      secrets: async () => secretsService,
    });
    const githubEffects = new PgEffectStore(runTransactions);
    const githubTools = buildGitHubTools(DEPLOYMENT_BUSINESS_ID, {
      ...githubTooling,
      effects: githubEffects,
    });

    // Slack send tool: same effect-ledger dispatch pattern as GitHub. Writes an
    // `integration_conversations` mapping on send (see `tools/slack/tools.ts`) so a human reply in
    // the sent message's thread routes back to this conversation instead of starting a new one.
    const slackTooling = buildSlackTooling({
      secrets: async () => secretsService,
    });
    const slackEffects = new PgEffectStore(runTransactions);
    const slackTools = buildSlackTools(DEPLOYMENT_BUSINESS_ID, {
      ...slackTooling,
      effects: slackEffects,
      threads: integrationThreads,
      mentionedThreads: channelMentionedThreads,
    });

    // Full chat tool registry: memory + knowledge (platform) plus every forge family
    // (resource records/types, agents, skills, platform tools). Without this, a chat turn only
    // sees memory+knowledge and no agent can create/curate soul artifacts. Per-agent allowlists
    // (which tools each agent may actually call) are applied per-turn in the chat route.
    const toolRegistry = buildToolRegistry({
      memory: memoryService,
      memoryRecall: memoryRecallService,
      memoryLifecycle: memoryLifecycleService,
      kv: kvService,
      knowledge: knowledgeService,
      surfaceComponents: { gitSync, surfaceSupport: surfaceRendererRegistry },
      resources: {
        repoFactory: resourceRepoFactory,
        counterStore,
        soulLoader,
        hookExecutor,
        events: domainEventEmitter,
      },
      resourceTypes: { gitSync, soulLoader, reconcile: reconcileResources },
      agentTools: { gitSync, soulLoader },
      skillTools: {
        gitSync,
        soulLoader,
        llmService,
        bundledSkills,
        disabledBundledSkills,
      },
      github: githubTools,
      slack: slackTools,
      platform: {
        events: domainEventEmitter,
        soulLoader,
        soulPath,
        gitSync,
        bundledSkills,
        disabledBundledSkills,
        triggerRoutine: manualRoutineTrigger(invocations),
        onRoutinesChanged: async () => {
          await soulLoader.reload();
          // Ticks immediately so a newly-authored/edited schedule is reconciled without waiting up
          // to SCHEDULE_DISPATCH_INTERVAL_MS for the next periodic tick.
          await scheduleDispatcher.tick();
        },
      },
    });

    // Manifest-declared integrations publish their Tools here rather than through
    // `buildToolRegistry`: what they publish depends on which are connected *now*, and an operator
    // who connects a provider expects its Tools without an API restart.
    const declarativeTools = new DeclarativeToolSync({
      registry: toolRegistry,
      integrations: () => soulLoader.integrations.values(),
      businessId: DEPLOYMENT_BUSINESS_ID,
      effects: slackEffects,
      secrets: async () => secretsService,
      http: new FetchEgressHttp(),
      logger: () => app.log,
    });

    // What the Worker calls back into while the history, the Soul artifacts, and the Tool catalog
    // still live here. Every operation names a Run and acts as the subject that Run was minted
    // with, so a worker credential is a key to a Run rather than a principal of its own.
    const conversationStore = new PgConversationStore(pool);
    const runArtifacts = new ArtifactService(
      new ArtifactStore(runTransactions),
      invocationValidator
    );
    const internalTurns = {
      host: new InternalTurnHost({
        runs: runStore,
        store: conversationStore,
        memory: memoryExtractionService,
        context: new ChatTurnContextResolver({
          artifacts: runArtifacts,
          store: conversationStore,
          soulLoader,
          toolRegistry,
          memory: memoryService,
          memoryRecall: memoryRecallService,
          kv: kvService,
          knowledge: knowledgeService,
          guardrails: guardrailsService,
          bundledSkills,
          disabledBundledSkills,
          channelDeliveries: channelRunDeliveries,
          githubStatus: { integrations: integrationStore, businessId: DEPLOYMENT_BUSINESS_ID },
        }),
        tools: new RegistryToolDispatcher({
          registry: toolRegistry,
          artifacts: runArtifacts,
          soulLoader,
          approvals: toolApprovals,
          channelDeliveries: channelRunDeliveries,
          surfaceStore: surfaceArtifactStore,
          surfaceActionStore,
          guardrails: guardrailsService,
          githubStatus: { integrations: integrationStore, businessId: DEPLOYMENT_BUSINESS_ID },
          // The flip. Until these two are supplied the dispatcher runs every registered Tool on
          // the agent allowlist alone; with them, no chat Tool executes without a grant.
          gate: new LiveToolGate(),
          authorityLayers: authorityLayerResolver,
          // D7. Without this every provider Tool spends the deployment's shared credential and the
          // provider sees one actor for the whole business, so its own ACLs stop discriminating.
          credentials: new CredentialResolver({ tokens: principalTokens, soulLoader }),
          // Authority layer L5. Every GitHub Tool spends the App installation's credential, so
          // without this the platform's answer to "may this person touch that repo" is whatever
          // the bot can reach — the union of everyone's access.
          entitlements: new CompositeToolEntitlement([
            new GitHubEntitlementPort(
              externalIdentityRepo,
              new HttpGitHubPermissionApi(githubTooling.installationToken)
            ),
          ]),
          // s6-ledger. Without this a mutating platform Tool — Record CRUD, Soul Forge, memory,
          // key-value — has no reservation, so a duplicate delivery of the same tool call applies
          // its write twice, and a Tool that throws leaves nothing for reconciliation to find.
          effects: new PgEffectStore(runTransactions),
        }),
        approvals: {
          // The subject comes from the Run, so the principal allowed to decide is the one the Run
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
      // The channel side of the same boundary: a delivery Run classifies in the Worker and comes
      // back here for the conversation, the identity, and the reply. Built per-app rather than
      // eagerly because it logs through Fastify's logger, which does not exist until `buildApp`
      // has run.
      deliveries: (log: FastifyBaseLogger) =>
        new IngressDeliveryHost({
          runs: runStore,
          artifacts: runArtifacts,
          store: conversationStore,
          conversations: conversationRepo,
          threads: integrationThreads,
          integrationEvents,
          soulLoader,
          identity: new IngressIdentityResolver({
            users: userRepo,
            log,
            mappings: externalIdentityRepo,
            bind: channelBind,
          }),
          toolRegistry,
          domainEvents: domainEventEmitter,
          // The link is redeemed inside an authenticated web session, so it must point at the
          // origin users actually reach — not at this API's own host.
          bindLinkUrl: (token) =>
            `${(process.env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/+$/, "")}/link-channel?token=${encodeURIComponent(token)}`,
          log,
        }),
      // Read through the loader on every call, so a `soul.synced` reload reaches the Worker
      // without restarting it.
      llmConfig: () => soulLoader.llmConfig,
      // A Routine State that needs a human parks on a durable wait registered here, for the same
      // reason: the resume token stays in the process that redeems it.
      routineApprovals: new InternalRoutineApprovalHost({
        runs: runStore,
        db: pool,
        withTransaction: (operation) => withTransaction(pool, operation),
        resume: runResume,
      }),
    };

    const app = await buildApp({
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
      // OIDC and MFA verifiers are adapter-supplied; absent means those routes stay closed.
      identity: {
        apiClientRepo,
        externalIdentityRepo,
        channelBind,
      },
      rateLimiter,
      secretsService,
      gitSync,
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
      // The REST record API is the same records the Record Tools reach, by a different door. The
      // domain wall the gate enforces is only a wall if this door enforces it too.
      recordAuthorizer: new LiveRecordAuthorizer(soulLoader, authorityLayerResolver),
      reconcileResources,
      // Reload Soul then project Roles, in that order — the reconciler reads the loader's catalog,
      // so projecting without reloading would write the state from before the level was committed.
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
      guardrailsService,
      conversationRepo,
      messageRepo,
      feedbackRepo,
      surfaceArtifactStore,
      surfaceActionStore,
      memoryService,
      memoryExtractionService,
      memoryLifecycleService,
      kvService,
      knowledgeService,
      toolRegistry,
      declarativeTools,
      activityService,
      auditService,
      auditReadService,
      authzAdmin,
      observabilityService,
      observabilityConfig: obsConfig,
      invocations,
      conversationStore,
      runCancel,
      internalTurns,
      approvalsRepo,
      routineApprovals,
      routineCatalog: new ActiveRoutineCatalog(
        soulPublications,
        soulBundleVerifier,
        DEPLOYMENT_BUSINESS_ID
      ),
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
        // Same construction as the webhook-ingress `deliveries` factory above — the link is
        // redeemed inside an authenticated web session, so it must point at the origin users
        // actually reach, not this API's own host.
        bindLinkUrl: (token) =>
          `${(process.env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/+$/, "")}/link-channel?token=${encodeURIComponent(token)}`,
      }),
      runEvents: {
        events: runEventStore,
        runs: runStore,
        // Every authenticated principal of this single-business deployment may read its own Runs.
        // Operator-audience events stay admin-only.
        authorize: async (req) => {
          const principal = req.principal;
          if (!principal) return null;
          return {
            businessId: principal.businessId,
            audiences:
              principal.kind === "user" && principal.role === "admin"
                ? ["participant", "operator"]
                : ["participant"],
          };
        },
      },
      operationalApi: createRuntimeOperationalApi({
        activity: activityService,
        approvals: approvalsRepo,
        toolApprovals,
        runs: createRunReader(runStore),
        healthProbes: [
          postgresProbe(pool),
          queueProbe(boss),
          soulProbe(gitSync),
          soulPublicationProbe(pool),
          llmProbe(llmService),
        ],
        // Routine-state Approvals resume through the routine wake queue, which has no consumer
        // in this deployment (the Routine engine has been removed). Deciding one would silently
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
      })
    );

    // Init after buildApp so fallback events log through Fastify's Pino logger.
    declarativeTools.sync();
    await llmService.init(soulLoader.llmConfig, secretsService, app.log);
    guardrailsService.init(soulLoader.guardrailsConfig, app.log);
    await embeddingService.init(soulLoader.llmConfig, secretsService, app.log);
    registerLlmReload(
      gitSync,
      soulLoader,
      llmService,
      embeddingService,
      secretsService,
      app.log,
      () => knowledgeService.runReindexIfPending().then(() => undefined)
    );
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
    // creating the first account.
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
    await registerObsPruneSchedule(boss, obsConfig.retentionDays * 24 * 60 * 60 * 1000);
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
    await registerEmbeddingBackfill(boss, {
      db: pool,
      embeddings: embeddingService,
      log: app.log,
    });
    subscribeKnowledgeIndexing(domainEventEmitter, boss);
    subscribeActivityLogging(domainEventEmitter, activityService);
    // Optional Grafana Cloud OTLP metrics export (gated). Only constructed when enabled + targeted +
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
    // Cost is computed primarily from each model's pinned soul spec (resolved from LiteLLM when the
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
    await registerConfluenceKnowledgeSync(boss, {
      soulLoader,
      secrets: secretsService,
      checkpoints: new PgConfluenceKnowledgeCheckpointStore(pool),
      sink: new PgKnowledgeEmissionSink(knowledgeSourceStore, knowledgeIndexStore),
      sources: knowledgeSourceStore,
      identity: new ExternalLinkKnowledgeIdentityMap(externalIdentityRepo),
      activity: activityService,
    });
    await registerK3KnowledgeSync(boss, {
      soulLoader,
      secrets: secretsService,
      checkpoints: (provider) => new PgProviderKnowledgeCheckpointStore(pool, provider),
      sink: new PgKnowledgeEmissionSink(knowledgeSourceStore, knowledgeIndexStore),
      sources: knowledgeSourceStore,
      identity: new ExternalLinkKnowledgeIdentityMap(externalIdentityRepo),
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
      // alive holding the port — force exit if graceful shutdown overruns.
      const force = setTimeout(() => {
        app.log.error("Shutdown timed out after 5s — forcing exit");
        process.exit(1);
      }, 5000);
      force.unref();
      try {
        if (soulSyncInterval) clearInterval(soulSyncInterval);
        clearInterval(soulPublicationDrainInterval);
        await app.close();
        await boss.stop({ graceful: false });
        // Final flush so metrics/spans buffered since the last interval tick aren't lost on exit.
        await metricsSink?.flush();
        metricsSink?.stop();
        await tracesSink?.flush();
        tracesSink?.stop();
        await hookExecutor?.close();
        // Before pool.end(): the sink writes through this pool, so draining after it closes would
        // lose exactly the shutdown-path errors an operator most needs to see.
        await resourceSampler.stop();
        await logSink.stop();
        await pool.end();
      } catch (err) {
        app.log.error(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        // The throw may have skipped the stop() above, and the next line exits the process. Flush
        // so the error explaining a failed shutdown is not the one record this feature loses; if
        // the pool is already closed it degrades to stderr, which still beats dropping it.
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
