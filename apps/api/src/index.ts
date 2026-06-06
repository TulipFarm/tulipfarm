import { MongoSecretRepo, SecretsService, loadEncryptionKeys } from "@tulipfarm/secrets";
import { GitSyncService, SoulLoader, runSoulMigrations } from "@tulipfarm/soul";
import { Queue, Worker } from "bullmq";
import { config } from "dotenv";
import Redis from "ioredis";
import { buildApp } from "./app";
import { MongoTokenRepo } from "./auth/api-tokens";
import { RedisSessionStore } from "./auth/session-store";
import { MongoUserRepo, bootstrapAdmin } from "./auth/users";
import { connectDb } from "./db";
import { runDataMigrations } from "./migrate";
import { RedisRateLimiter } from "./rate-limit";

// Load .env.local (symlinked from root by setup script)
config({ path: ".env.local" });

// Validate required environment variables at startup
export function validateBase64Secret(
  name: string,
  env: Record<string, string | undefined>,
  exit: (code: number) => void
): void {
  try {
    const buf = Buffer.from(env[name] as string, "base64");
    if (buf.length !== 32) {
      console.error(`❌ ${name} must be 32 bytes base64 (got ${buf.length} bytes)`);
      console.error("   Generate with: openssl rand -base64 32");
      exit(1);
    }
  } catch {
    console.error(`❌ ${name} is not valid base64`);
    exit(1);
  }
}

export function validateUriPrefix(
  name: string,
  prefixes: string[],
  env: Record<string, string | undefined>,
  exit: (code: number) => void
): void {
  const value = env[name] as string;
  if (!prefixes.some((p) => value.startsWith(p))) {
    console.error(`❌ ${name} must start with ${prefixes.join(" or ")}`);
    exit(1);
  }
}

export function validateEnvironment(
  env: Record<string, string | undefined> = process.env,
  exit: (code: number) => void = process.exit
): void {
  const required = [
    "MONGODB_URI",
    "REDIS_URL",
    "SOUL_PATH",
    "ENCRYPTION_KEY",
    "JWT_SECRET",
    "WEBHOOK_SIGNING_SECRET",
  ];
  const missing = required.filter((key) => !env[key]);

  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
    console.error("📋 Copy .env.local.example to .env.local and generate secrets:");
    console.error("   openssl rand -base64 32");
    exit(1);
  }

  // Validate all secrets are 32 bytes base64
  for (const name of ["ENCRYPTION_KEY", "JWT_SECRET", "WEBHOOK_SIGNING_SECRET"]) {
    validateBase64Secret(name, env, exit);
  }

  // Validate URI prefixes
  validateUriPrefix("MONGODB_URI", ["mongodb://", "mongodb+srv://"], env, exit);
  validateUriPrefix("REDIS_URL", ["redis://", "rediss://"], env, exit);

  // Validate ENCRYPTION_KEY_PREVIOUS if set (optional, used for key rotation)
  if (env.ENCRYPTION_KEY_PREVIOUS !== undefined) {
    validateBase64Secret("ENCRYPTION_KEY_PREVIOUS", env, exit);
  }

  // Validate SESSION_TTL_SECONDS if set (optional)
  if (env.SESSION_TTL_SECONDS !== undefined) {
    const ttl = Number.parseInt(env.SESSION_TTL_SECONDS, 10);
    if (Number.isNaN(ttl) || ttl <= 0) {
      console.error("❌ SESSION_TTL_SECONDS must be a positive integer");
      exit(1);
    }
  }
}

function logEnvironmentStatus(logger: { info: (msg: string) => void }): void {
  const vars = [
    "MONGODB_URI",
    "REDIS_URL",
    "SOUL_PATH",
    "ENCRYPTION_KEY",
    "JWT_SECRET",
    "WEBHOOK_SIGNING_SECRET",
  ];
  const status = vars.map((name) => `${name}: ✓ set`).join(", ");
  logger.info(`Environment validated — ${status}`);
}

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
    gitSync.on("soul.synced", () =>
      soulLoader
        .reload()
        .catch((err: unknown) =>
          console.error(`Soul: reload failed — ${err instanceof Error ? err.message : String(err)}`)
        )
    );

    const { db } = await connectDb();
    await runDataMigrations(db);

    const redis = new Redis(process.env.REDIS_URL as string);
    const ttlSeconds = Number.parseInt(process.env.SESSION_TTL_SECONDS ?? "604800", 10);
    const sessionStore = new RedisSessionStore(redis, ttlSeconds);
    const userRepo = new MongoUserRepo(db);
    const tokenRepo = new MongoTokenRepo(db);
    const rateLimiter = new RedisRateLimiter(redis, console);

    const secretRepo = new MongoSecretRepo(db);
    const encryptionKeys = loadEncryptionKeys();
    const secretsService = new SecretsService(secretRepo, encryptionKeys);

    const app = await buildApp({
      sessionStore,
      userRepo,
      tokenRepo,
      rateLimiter,
      secretsService,
      gitSync,
    });
    logEnvironmentStatus(app.log);
    await bootstrapAdmin(userRepo, app.log);

    app.listen({ port, host: "0.0.0.0" }, (err) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
      if (process.env.GIT_REMOTE_URL) {
        const bullConnection = { url: process.env.REDIS_URL as string };
        const syncQueue = new Queue("soul-sync", { connection: bullConnection });
        new Worker("soul-sync", () => gitSync.syncOnce(), { connection: bullConnection });
        syncQueue
          .upsertJobScheduler("soul-sync-periodic", { every: 5 * 60 * 1000 })
          .catch((err) => app.log.error(`Soul: failed to register sync scheduler — ${err}`));
      }
    });
  } catch (error) {
    console.error(`❌ Boot failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

boot();
