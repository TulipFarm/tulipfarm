import { EmbeddingService, LlmService } from "@tulipfarm/llm";
import { MongoSecretRepo, SecretsService, loadEncryptionKeys } from "@tulipfarm/secrets";
import { GitSyncService, SoulLoader, runSoulMigrations } from "@tulipfarm/soul";
import { Queue, Worker } from "bullmq";
import { config } from "dotenv";
import Redis from "ioredis";
import { buildApp } from "./app";
import { MongoTokenRepo } from "./auth/api-tokens";
import { DEFAULT_SESSION_TTL_SECONDS, RedisSessionStore } from "./auth/session-store";
import { MongoUserRepo, bootstrapAdmin } from "./auth/users";
import { MongoConversationRepo } from "./chat/conversations";
import { MongoMessageRepo } from "./chat/messages";
import { connectDb } from "./db";
import { logEnvironmentStatus, validateEnvironment } from "./env";
import { HookExecutor } from "./hooks/hook-executor";
import { registerLlmReload } from "./llm-reload";
import { WorkingMemoryService } from "./memory/service";
import { MongoWorkingMemoryRepo } from "./memory/working-memory";
import { runDataMigrations } from "./migrate";
import { RedisRateLimiter } from "./rate-limit";

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

    const { client, db } = await connectDb();
    await runDataMigrations(db);

    const redis = new Redis(process.env.REDIS_URL as string);
    const ttlSeconds = Number.parseInt(
      process.env.SESSION_TTL_SECONDS ?? String(DEFAULT_SESSION_TTL_SECONDS),
      10
    );
    const sessionStore = new RedisSessionStore(redis, ttlSeconds);
    const userRepo = new MongoUserRepo(db);
    const tokenRepo = new MongoTokenRepo(db);
    const rateLimiter = new RedisRateLimiter(redis, console);

    const secretRepo = new MongoSecretRepo(db);
    const encryptionKeys = loadEncryptionKeys();
    const secretsService = new SecretsService(secretRepo, encryptionKeys);

    const hookExecutor =
      process.env.HOOKS_DISABLED === "true"
        ? undefined
        : new HookExecutor(process.env.MONGODB_URI as string, db.databaseName);

    const llmService = new LlmService();
    const embeddingService = new EmbeddingService();
    const conversationRepo = new MongoConversationRepo(db);
    const messageRepo = new MongoMessageRepo(db);
    const workingMemoryService = new WorkingMemoryService(new MongoWorkingMemoryRepo(db));

    const app = await buildApp({
      sessionStore,
      userRepo,
      tokenRepo,
      rateLimiter,
      secretsService,
      gitSync,
      soulLoader,
      hookExecutor,
      db,
      llmService,
      conversationRepo,
      messageRepo,
      workingMemoryService,
    });

    // Init after buildApp so fallback events log through Fastify's Pino logger.
    await llmService.init(soulLoader.llmConfig, secretsService, app.log);
    await embeddingService.init(soulLoader.llmConfig, secretsService, app.log);
    registerLlmReload(gitSync, soulLoader, llmService, embeddingService, secretsService, app.log);
    logEnvironmentStatus(app.log);
    await bootstrapAdmin(userRepo, app.log);

    let syncQueue: Queue | undefined;
    let syncWorker: Worker | undefined;

    app.listen({ port, host: "0.0.0.0" }, (err) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
      if (process.env.GIT_REMOTE_URL) {
        const bullConnection = { url: process.env.REDIS_URL as string };
        syncQueue = new Queue("soul-sync", { connection: bullConnection });
        syncWorker = new Worker("soul-sync", () => gitSync.syncOnce(), {
          connection: bullConnection,
        });
        syncQueue
          .upsertJobScheduler("soul-sync-periodic", { every: 5 * 60 * 1000 })
          .catch((err) => app.log.error(`Soul: failed to register sync scheduler — ${err}`));
      }
    });

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info(`Received ${signal} — shutting down gracefully`);
      try {
        await app.close();
        await syncWorker?.close();
        await syncQueue?.close();
        await hookExecutor?.close();
        await redis.quit();
        await client.close();
      } catch (err) {
        app.log.error(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      }
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
