import { EventEmitter } from "node:events";
import { EmbeddingService, LlmService } from "@tulipfarm/llm";
import { PgSecretRepo, SecretsService, loadEncryptionKeys } from "@tulipfarm/secrets";
import { GitSyncService, SoulLoader, runSoulMigrations } from "@tulipfarm/soul";
import { config } from "dotenv";
import PgBoss from "pg-boss";
import { buildApp } from "./app";
import { PgTokenRepo } from "./auth/api-tokens";
import { cookieSecure } from "./auth/cookie-secure";
import { DEFAULT_SESSION_TTL_SECONDS, PgSessionStore } from "./auth/session-store";
import { PgUserRepo } from "./auth/users";
import { PgConversationRepo } from "./chat/conversations";
import { PgMessageRepo } from "./chat/messages";
import { registerStreamGc } from "./chat/stream-gc";
import { StreamHub } from "./chat/stream-hub";
import { PgStreamResumeRepo } from "./chat/stream-resume";
import { connectPg } from "./db";
import { logEnvironmentStatus, validateEnvironment } from "./env";
import { HookExecutor } from "./hooks/hook-executor";
import { PgKnowledgeChunkRepo } from "./knowledge/chunks-repo";
import { subscribeKnowledgeIndexing } from "./knowledge/events";
import { enqueueIndex, registerKnowledgeIndexing } from "./knowledge/indexing";
import {
  PgKnowledgeCollectionRepo,
  PgKnowledgeDocumentRepo,
  PgKnowledgeRevisionRepo,
} from "./knowledge/repo";
import { KnowledgeService } from "./knowledge/service";
import { registerLlmReload } from "./llm-reload";
import { WorkingMemoryService } from "./memory/service";
import { PgWorkingMemoryRepo } from "./memory/working-memory";
import { runPgMigrations } from "./pg-migrate";
import { PgRateLimiter } from "./rate-limit";
import { reconcileResourceTables, registerResourceReconcile } from "./resources/reconcile";
import { PgCounterStore, PgResourceRepoFactory } from "./resources/repo";
import { bootstrapFromEnv } from "./setup/bootstrap";
import { isManagedMode } from "./setup/service";
import { registerSoulSync } from "./soul-sync";

// Load .env.local (symlinked from root by setup script)
config({ path: ".env.local" });

validateEnvironment();

const port = Number.parseInt(process.env.PORT || "4010", 10);

async function boot() {
  try {
    const gitSync = new GitSyncService(
      process.env.SOUL_PATH as string,
      process.env.GIT_REMOTE_URL,
      process.env.GIT_CREDENTIALS,
      console
    );
    await gitSync.bootSync();

    await runSoulMigrations(process.env.SOUL_PATH as string, console);

    const soulLoader = new SoulLoader(process.env.SOUL_PATH as string, console);
    await soulLoader.load();

    const pool = await connectPg();
    await runPgMigrations(pool);
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
    const rateLimiter = new PgRateLimiter(pool);

    const secretRepo = new PgSecretRepo(pool);
    const encryptionKeys = loadEncryptionKeys();
    const secretsService = new SecretsService(secretRepo, encryptionKeys);

    const hookExecutor =
      process.env.HOOKS_DISABLED === "true"
        ? undefined
        : new HookExecutor(process.env.DATABASE_URL as string);

    const llmService = new LlmService();
    const embeddingService = new EmbeddingService();
    const conversationRepo = new PgConversationRepo(pool);
    const messageRepo = new PgMessageRepo(pool);
    const streamResumeRepo = new PgStreamResumeRepo(pool);
    const streamHub = new StreamHub();
    const workingMemoryService = new WorkingMemoryService(new PgWorkingMemoryRepo(pool));
    const resourceRepoFactory = new PgResourceRepoFactory(pool);
    const counterStore = new PgCounterStore(pool);
    const reconcileResources = () => reconcileResourceTables(pool, soulLoader, console);

    // pg-boss starts before buildApp so the knowledge service's async-index callback can enqueue.
    const domainEventEmitter = new EventEmitter();
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL as string });
    await boss.start();

    const knowledgeService = new KnowledgeService({
      documents: new PgKnowledgeDocumentRepo(pool),
      chunks: new PgKnowledgeChunkRepo(pool),
      collections: new PgKnowledgeCollectionRepo(pool),
      revisions: new PgKnowledgeRevisionRepo(pool),
      embeddings: embeddingService,
      enqueueIndex: (documentId) =>
        enqueueIndex(boss, { kind: "document", documentId }).then(() => undefined),
    });

    const app = await buildApp({
      sessionStore,
      userRepo,
      tokenRepo,
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
      conversationRepo,
      messageRepo,
      streamResumeRepo,
      streamHub,
      workingMemoryService,
      knowledgeService,
    });

    // Init after buildApp so fallback events log through Fastify's Pino logger.
    await llmService.init(soulLoader.llmConfig, secretsService, app.log);
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
    registerResourceReconcile(gitSync, soulLoader, pool, app.log);
    logEnvironmentStatus(app.log);
    // INST-003b: seed admin (+ business profile + LLM key) from env. Idempotent;
    // generalizes the old bootstrapAdmin. Managed mode fails loud on missing env.
    await bootstrapFromEnv({
      userRepo,
      secretsService,
      soulPath: process.env.SOUL_PATH as string,
      log: app.log,
    });

    // Security boot warnings (INST-003c). The first-admin endpoint is open until an
    // account exists; on a public-IP install the window is claimable, so warn loudly.
    if (!isManagedMode() && (await userRepo.count()) === 0) {
      app.log.warn(
        "Setup is OPEN: anyone who can reach this port can claim the first admin account. Complete /setup now and front it with TLS for production."
      );
    }
    // The Secure cookie flag is derived from PUBLIC_URL's scheme; warn if we're in
    // production but shipping non-Secure cookies (PUBLIC_URL is http/unset).
    if (process.env.NODE_ENV === "production" && !cookieSecure()) {
      app.log.warn(
        "Session/CSRF cookies are NOT marked Secure (PUBLIC_URL is not https). Set an https PUBLIC_URL behind TLS for production."
      );
    }

    await registerSoulSync(boss, gitSync, process.env.GIT_REMOTE_URL);
    await registerStreamGc(boss, streamResumeRepo);
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
    });
    subscribeKnowledgeIndexing(domainEventEmitter, boss);

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
