import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { GuardrailsService } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { EmbeddingService, LlmService } from "@tulipfarm/llm";
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
  GitSyncService,
  PgBundleStore,
  runSoulMigrations,
  SoulLoader,
  SoulPublicationCoordinator,
} from "@tulipfarm/soul";
import {
  ArtifactStore,
  ChannelRunDeliveryStore,
  ChildLinkStore,
  EventStore,
  IntegrationStore,
  PgSoulPublicationStore,
  RunEventStore,
  RunStore,
  WaitStore,
} from "@tulipfarm/storage";
import { config } from "dotenv";
import type { FastifyBaseLogger } from "fastify";
import { PgBoss } from "pg-boss";
import { subscribeActivityLogging } from "./activity/events";
import { PgActivityRepo } from "./activity/repo";
import { ActivityService } from "./activity/service";
import { llmProbe, postgresProbe, queueProbe, soulProbe } from "./admin/health";
import { OperationalNotImplementedError } from "./admin/routes";
import { createRunReader } from "./admin/run-reader";
import { createRuntimeOperationalApi } from "./admin/runtime";
import { buildApp } from "./app";
import { RoutineApprovalService } from "./approvals/routine-approvals";
import { ApprovalsRepo } from "./approvals/runtime-repo";
import { ToolApprovalService } from "./approvals/tool-approvals";
import { PgTokenRepo } from "./auth/api-tokens";
import { DEFAULT_SESSION_TTL_SECONDS, PgSessionStore } from "./auth/session-store";
import { PgUserRepo } from "./auth/users";
import { PgConversationRepo } from "./chat/conversations";
import { PgMessageRepo } from "./chat/messages";
import { PgConversationStore } from "./conversations/store.pg";
import { ambientTransactionPort, connectPg, transactionPort, withTransaction } from "./db";
import { logEnvironmentStatus, validateEnvironment } from "./env";
import { FeedbackRepo } from "./feedback/repo";
import { registerGuardrailsReload } from "./guardrails/reload";
import { createHookExecutor } from "./hooks/executor";
import { PgRawPayloadVault } from "./hooks/raw-payload-vault";
import { webhookSecretPort } from "./hooks/secret-port";
import { PgApiClientRepo } from "./identity/api-clients";
import { channelBindKeyResolver } from "./identity/channel-link";
import { PgExternalIdentityRepo } from "./identity/external-links";
import { IngressIdentityResolver } from "./ingress/identity";
import {
  IngressDeliveriesRepo,
  IntegrationConversationsRepo,
  IntegrationEventsRepo,
} from "./ingress/repo";
import { resolveSecretRef } from "./integrations/connection-env";
import { IngressDeliveryHost } from "./internal/delivery-host";
import { InternalRoutineApprovalHost } from "./internal/routine-approval-host";
import { RegistryToolDispatcher } from "./internal/tool-dispatch";
import { ChatTurnContextResolver } from "./internal/turn-context";
import { InternalTurnHost } from "./internal/turn-host";
import { PgKnowledgeChunkRepo } from "./knowledge/chunks-repo";
import { buildDefaultRegistry } from "./knowledge/connectors/registry";
import { PgConnectorStateRepo } from "./knowledge/connectors/state-repo";
import { registerConnectorSync } from "./knowledge/connectors/sync";
import { subscribeKnowledgeIndexing } from "./knowledge/events";
import { enqueueIndex, makeIndexQueueStats, registerKnowledgeIndexing } from "./knowledge/indexing";
import { PgKnowledgeLinksRepo } from "./knowledge/links-repo";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./knowledge/repo";
import { KnowledgeService } from "./knowledge/service";
import { PgKnowledgeSpaceOverrideRepo } from "./knowledge/space-overrides-repo";
import { PgKnowledgeSpaceRepo } from "./knowledge/spaces-repo";
import { PgKvRepo } from "./kv/repo";
import { KvService } from "./kv/service";
import { registerLlmReload } from "./llm-reload";
import { WorkingMemoryService } from "./memory/service";
import { PgWorkingMemoryRepo } from "./memory/working-memory";
import { parseObservabilityConfig } from "./observability/config";
import { subscribeObservability } from "./observability/events";
import { OtlpMetricsExporter } from "./observability/metrics";
import { registerObsPruneSchedule } from "./observability/prune-schedule";
import { PgObsRepo } from "./observability/repo";
import { ObservabilityService } from "./observability/service";
import { OtlpTracesExporter } from "./observability/traces";
import { runPgMigrations } from "./pg-migrate";
import { PgRateLimiter } from "./rate-limit";
import { reconcileResourceTables, registerResourceReconcile } from "./resources/reconcile";
import { PgCounterStore, PgResourceRepoFactory } from "./resources/repo";
import { runCanceller } from "./runs/cancel";
import {
  integrationInvoker,
  manualRoutineTrigger,
  triggerRunStarter,
} from "./runtime/invocation-callers";
import {
  ActiveRoutineInvocationResolver,
  ActiveTriggerInvocationResolver,
  ActiveWebhookTriggerResolver,
} from "./runtime/invocation-definitions";
import { resolveSoulBundleSigner } from "./runtime/soul-bundle-signer";
import { bootstrapFromEnv } from "./setup/bootstrap";
import {
  assertNoOrphanedDeks,
  type BootstrapSecretsResult,
  bootstrapSecrets,
} from "./setup/bootstrap-secrets";
import { readSoulConfig, SOUL_GIT_CREDENTIAL_KEY } from "./setup/soul-config";
import { provisionWorkerCredential } from "./setup/worker-credential";
import { loadBundledIntegrations } from "./soul/integrations/bundled";
import { loadBundledSkills, loadDisabledBundledSkills } from "./soul/skills/bundled";
import { registerSoulSync } from "./soul-sync";
import { PgSurfaceActionStore } from "./surfaces/action-store";
import { PgSurfaceArtifactStore } from "./surfaces/artifact-store";
import { surfaceRendererRegistry } from "./surfaces/renderer-registry";
import { buildToolRegistry } from "./tools/setup";

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

async function boot() {
  try {
    const pool = await connectPg();
    await runPgMigrations(pool);

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

    const soulPath = process.env.SOUL_PATH as string;
    // SOUL_GIT_REMOTE_URL/SOUL_GIT_CREDENTIAL only seed the very first boot. Once Settings → Soul
    // persists a remote (soul.yaml's gitRemoteUrl + the "soul-git-credential" secret), that takes
    // over — otherwise a restart would forget a remote configured after boot.
    const persistedSoulConfig = await readSoulConfig(soulPath);
    const gitRemoteUrl = persistedSoulConfig.gitRemoteUrl ?? process.env.SOUL_GIT_REMOTE_URL;
    const gitCredential =
      (await secretsService.get(SOUL_GIT_CREDENTIAL_KEY).catch(() => undefined)) ??
      process.env.SOUL_GIT_CREDENTIAL;

    const gitSync = new GitSyncService(soulPath, gitRemoteUrl, gitCredential, console);
    // A stale/invalid remote (revoked PAT, unreachable host) must never crash-loop boot — fall
    // back to whatever soul state is already on disk and keep serving. `configureRemote` (the
    // Settings → Soul PUT route) still throws on the same failure so the user sees it there.
    try {
      await gitSync.bootSync();
    } catch (err) {
      console.error(
        `Soul: boot sync with remote failed (${err instanceof Error ? err.message : String(err)}) — continuing with local soul state`
      );
    }

    await runSoulMigrations(soulPath, console);

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
    const tokenRepo = new PgTokenRepo(pool);
    const apiClientRepo = new PgApiClientRepo(pool);
    const externalIdentityRepo = new PgExternalIdentityRepo(pool);
    const rateLimiter = new PgRateLimiter(pool);
    // One validator for the request boundary: the gateway rejects an unregistered schema reference
    // before minting a Run, and the same instance re-validates on publish and on every later read.
    const invocationValidator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
    const runTransactions = transactionPort(pool);
    const soulBundleSigner = await resolveSoulBundleSigner(secretsService);
    const soulPublications = new SoulPublicationCoordinator(
      new PgSoulPublicationStore(runTransactions),
      new PgBundleStore(runTransactions),
      console
    );
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
      routineDefinitions: new ActiveRoutineInvocationResolver(soulPublications, soulBundleSigner),
    });
    // Canonical event intake/outbox for Trigger invocation, shared in shape (not process) with the
    // Worker's own `EventStore` — this is the first API-side instantiation of it.
    const events = new EventStore(runTransactions, randomUUID);
    const triggerDefinitions = new ActiveTriggerInvocationResolver(
      soulPublications,
      soulBundleSigner,
      DEPLOYMENT_BUSINESS_ID
    );
    const webhookTriggerDefinitions = new ActiveWebhookTriggerResolver(
      soulPublications,
      soulBundleSigner,
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
        : createHookExecutor(process.env.DATABASE_URL as string);

    const llmService = new LlmService();
    const guardrailsService = new GuardrailsService();
    const embeddingService = new EmbeddingService();
    const conversationRepo = new PgConversationRepo(pool);
    const messageRepo = new PgMessageRepo(pool);
    const feedbackRepo = new FeedbackRepo(pool);
    const surfaceArtifactStore = new PgSurfaceArtifactStore(pool);
    const surfaceActionStore = new PgSurfaceActionStore(pool);
    const workingMemoryService = new WorkingMemoryService(new PgWorkingMemoryRepo(pool));
    const kvService = new KvService(new PgKvRepo(pool));
    const activityService = new ActivityService(new PgActivityRepo(pool));
    const observabilityService = new ObservabilityService(new PgObsRepo(pool));
    const obsConfig = parseObservabilityConfig(soulLoader.observabilityConfig);
    const resourceRepoFactory = new PgResourceRepoFactory(pool);
    const counterStore = new PgCounterStore(pool);
    const reconcileResources = () => reconcileResourceTables(pool, soulLoader, console);

    // pg-boss starts before buildApp so the knowledge service's async-index callback can enqueue.
    const domainEventEmitter = new EventEmitter();
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL as string });
    await boss.start();

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
    const channelIntegrations = new IntegrationStore(runTransactions);
    // The bind link's HMAC key comes from the secret store, provisioned on first use — never a
    // constant in the image, which every deployment would share.
    const channelBind = {
      repo: externalIdentityRepo,
      signingKey: channelBindKeyResolver(secretsService),
    };

    // Full chat tool registry: memory + knowledge (platform) plus every forge family
    // (resource records/types, agents, skills, platform tools). Without this, a chat turn only
    // sees memory+knowledge and no agent can create/curate soul artifacts. Per-agent allowlists
    // (which tools each agent may actually call) are applied per-turn in the chat route.
    const toolRegistry = buildToolRegistry({
      workingMemory: workingMemoryService,
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
      platform: {
        events: domainEventEmitter,
        soulLoader,
        soulPath: process.env.SOUL_PATH,
        gitSync,
        bundledSkills,
        disabledBundledSkills,
        triggerRoutine: manualRoutineTrigger(invocations),
        onRoutinesChanged: async () => {
          await soulLoader.reload();
        },
      },
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
        context: new ChatTurnContextResolver({
          artifacts: runArtifacts,
          store: conversationStore,
          llmService,
          soulLoader,
          toolRegistry,
          workingMemory: workingMemoryService,
          knowledge: knowledgeService,
          guardrails: guardrailsService,
          bundledSkills,
          disabledBundledSkills,
          channelDeliveries: channelRunDeliveries,
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
      sessionStore,
      userRepo,
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
      hookExecutor,
      resourceRepoFactory,
      counterStore,
      reconcileResources,
      domainEventEmitter,
      llmService,
      guardrailsService,
      conversationRepo,
      messageRepo,
      feedbackRepo,
      surfaceArtifactStore,
      surfaceActionStore,
      workingMemoryService,
      kvService,
      knowledgeService,
      toolRegistry,
      activityService,
      observabilityService,
      observabilityConfig: obsConfig,
      invocations,
      conversationStore,
      runCancel,
      internalTurns,
      approvalsRepo,
      routineApprovals,
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
          llmProbe(llmService),
        ],
        // Routine-state Approvals resume through the routine wake queue, which has no consumer
        // in this deployment (the Routine engine is not composed). Deciding one would silently
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

    // Init after buildApp so fallback events log through Fastify's Pino logger.
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
    logEnvironmentStatus(app.log);
    // Before the wizard, and independent of it: a deployment that never opens the wizard still
    // accepts Runs, so the Worker's credential cannot wait on a human creating the first account.
    await provisionWorkerCredential(apiClientRepo, process.env, app.log);
    await bootstrapFromEnv({
      userRepo,
      secretsService,
      soulPath: process.env.SOUL_PATH as string,
      log: app.log,
    });

    const soulSyncInterval = registerSoulSync(gitSync, gitRemoteUrl, {
      activity: activityService,
      soulLoader,
      log: app.log,
    });
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
    await registerConnectorSync(boss, {
      registry: buildDefaultRegistry(),
      state: new PgConnectorStateRepo(pool),
      service: knowledgeService,
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
        await app.close();
        await boss.stop({ graceful: false });
        // Final flush so metrics/spans buffered since the last interval tick aren't lost on exit.
        await metricsSink?.flush();
        metricsSink?.stop();
        await tracesSink?.flush();
        tracesSink?.stop();
        await hookExecutor?.close();
        await pool.end();
      } catch (err) {
        app.log.error(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
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
