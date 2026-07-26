import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { EmbeddingService, LlmService } from "@tulipfarm/llm";
import {
  loadEncryptionKeys,
  loadOrProvisionActiveDek,
  PgDekRepo,
  PgSecretRepo,
  SecretsService,
} from "@tulipfarm/secrets";
import { GitSyncService, runSoulMigrations, SoulLoader } from "@tulipfarm/soul";
import { config } from "dotenv";
import { PgBoss } from "pg-boss";
import { PgA2uiSurfaceStore } from "./a2ui/artifact-surface";
import { subscribeActivityLogging } from "./activity/events";
import { PgActivityRepo } from "./activity/repo";
import { ActivityService } from "./activity/service";
import { buildApp } from "./app";
import { DurableApprovalGate } from "./approvals/chat-gate";
import { ApprovalsRepo } from "./approvals/runtime-repo";
import { PgTokenRepo } from "./auth/api-tokens";
import { DEFAULT_SESSION_TTL_SECONDS, PgSessionStore } from "./auth/session-store";
import { PgUserRepo } from "./auth/users";
import { PgConversationRepo } from "./chat/conversations";
import { PgMessageRepo } from "./chat/messages";
import { PgPendingInteractionRepo } from "./chat/pending-interactions";
import { StreamHub } from "./chat/stream-hub";
import { PgStreamResumeRepo } from "./chat/stream-resume";
import { connectPg } from "./db";
import { logEnvironmentStatus, validateEnvironment } from "./env";
import { FeedbackRepo } from "./feedback/repo";
import { GuardrailsService } from "./guardrails";
import { registerGuardrailsReload } from "./guardrails/reload";
import { HookExecutor } from "./hooks/hook-executor";
import { PgApiClientRepo } from "./identity/api-clients";
import { PgExternalIdentityRepo } from "./identity/external-links";
import { IngressDeliveriesRepo } from "./ingress/repo";
import { resolveSecretRef } from "./integrations/connection-env";
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
import { registerObsPrune } from "./observability/prune";
import { PgObsRepo } from "./observability/repo";
import { ObservabilityService } from "./observability/service";
import { OtlpTracesExporter } from "./observability/traces";
import { runPgMigrations } from "./pg-migrate";
import { PgRateLimiter } from "./rate-limit";
import { reconcileResourceTables, registerResourceReconcile } from "./resources/reconcile";
import { PgCounterStore, PgResourceRepoFactory } from "./resources/repo";
import { DurableInvocationGateway } from "./runtime/invocation-gateway";
import { PgDurableInvocationStore } from "./runtime/invocation-store";
import { bootstrapFromEnv } from "./setup/bootstrap";
import { readSoulConfig, SOUL_GIT_CREDENTIAL_KEY } from "./setup/soul-config";
import { BUILTIN_SKILLS } from "./soul/skills/builtin-skills";
import { registerSoulSync } from "./soul-sync";
import { buildToolRegistry } from "./tools/setup";

// Load .env.local (symlinked from root by setup script)
config({ path: ".env.local" });

validateEnvironment();

const port = Number.parseInt(process.env.PORT || "4010", 10);

async function boot() {
  try {
    const pool = await connectPg();
    await runPgMigrations(pool);

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

    const soulLoader = new SoulLoader(soulPath, console);
    await soulLoader.load();

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
    const invocations = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(pool),
    });

    const hookExecutor =
      process.env.HOOKS_DISABLED === "true"
        ? undefined
        : new HookExecutor(process.env.DATABASE_URL as string);

    const llmService = new LlmService();
    const guardrailsService = new GuardrailsService();
    const embeddingService = new EmbeddingService();
    const conversationRepo = new PgConversationRepo(pool);
    const messageRepo = new PgMessageRepo(pool);
    const feedbackRepo = new FeedbackRepo(pool);
    const streamResumeRepo = new PgStreamResumeRepo(pool);
    const pendingInteractionRepo = new PgPendingInteractionRepo(pool);
    const a2uiSurfaceStore = new PgA2uiSurfaceStore(pool);
    const streamHub = new StreamHub();
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
    const approvalRegistry = new DurableApprovalGate(approvalsRepo);
    const ingressDeliveries = new IngressDeliveriesRepo(pool);

    // Full chat tool registry: memory + knowledge (platform) plus every forge family
    // (resource records/types, agents, skills, platform tools). Without this, a chat turn only
    // sees memory+knowledge and no agent can create/curate soul artifacts. Per-agent allowlists
    // (which tools each agent may actually call) are applied per-turn in the chat route.
    const toolRegistry = buildToolRegistry({
      workingMemory: workingMemoryService,
      kv: kvService,
      knowledge: knowledgeService,
      resources: {
        repoFactory: resourceRepoFactory,
        counterStore,
        soulLoader,
        hookExecutor,
        events: domainEventEmitter,
      },
      resourceTypes: { gitSync, soulLoader, reconcile: reconcileResources },
      agentTools: { gitSync, soulLoader },
      skillTools: { gitSync, soulLoader, llmService },
      platform: {
        soulLoader,
        soulPath: process.env.SOUL_PATH,
        gitSync,
        builtinSkills: BUILTIN_SKILLS,
        triggerRoutine: async (slug, inputs) => {
          const digest = createHash("sha256")
            .update(JSON.stringify(inputs ?? {}))
            .digest("hex");
          const result = await invocations.start({
            source: "manual",
            businessId: "default",
            initiator: { kind: "agent", id: "assistant" },
            effectiveSubject: { kind: "agent", id: "assistant" },
            definitionRef: `published:routine:${slug}`,
            payloadRef: `artifact:sha256:${digest}`,
            idempotencyKey: `${slug}:${digest}`,
          });
          return { runId: result.runId };
        },
        onRoutinesChanged: async () => {
          await soulLoader.reload();
        },
      },
    });

    const app = await buildApp({
      sessionStore,
      userRepo,
      tokenRepo,
      // OIDC and MFA verifiers are adapter-supplied; absent means those routes stay closed.
      identity: { apiClientRepo, externalIdentityRepo },
      rateLimiter,
      secretsService,
      gitSync,
      soulLoader,
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
      streamResumeRepo,
      pendingInteractionRepo,
      a2uiSurfaceStore,
      streamHub,
      workingMemoryService,
      kvService,
      knowledgeService,
      toolRegistry,
      activityService,
      observabilityService,
      observabilityConfig: obsConfig,
      invocations,
      approvalsRepo,
      approvalRegistry,
      ingress: {
        soulLoader,
        deliveries: ingressDeliveries,
        invoke: async (job) => {
          const digest = createHash("sha256").update(JSON.stringify(job)).digest("hex");
          await invocations.start({
            source: "integration",
            businessId: "default",
            initiator: { kind: "integration", id: job.slug },
            effectiveSubject: { kind: "integration", id: job.slug },
            definitionRef: `published:integration:${job.slug}`,
            payloadRef: `artifact:sha256:${digest}`,
            idempotencyKey: digest,
          });
        },
        resolveSecret: (value) => resolveSecretRef(value, secretsService),
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
    await bootstrapFromEnv({
      userRepo,
      secretsService,
      soulPath: process.env.SOUL_PATH as string,
      log: app.log,
    });

    await registerSoulSync(boss, gitSync, gitRemoteUrl, {
      activity: activityService,
      soulLoader,
    });
    await registerObsPrune(boss, new PgObsRepo(pool), activityService, {
      obs: observabilityService,
      retentionMs: obsConfig.retentionDays * 24 * 60 * 60 * 1000,
    });
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
