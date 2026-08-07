import { config as loadEnv } from "dotenv";
import { createSlackChannelLoops, watchForSlackChannelCredential } from "./channels";
import { loadConfig, REQUIRED_SCHEMA_VERSION } from "./config";
import { waitForDataDirEnv } from "./data-dir";
import { connectPg } from "./db";
import { waitForSchemaFloor } from "./preflight";
import { startProbeServer } from "./probe-server";
import { type DrainableLoop, drain } from "./shutdown";

const logger = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
  error: (message: string, error?: unknown) =>
    error === undefined ? console.error(message) : console.error(message, error),
};

/**
 * Composition root for the integration worker.
 *
 * Boot skeleton proving the process shape (schema-floor wait, `/livez`+`/readyz`, drain on
 * `SIGTERM`), plus the Slack Socket Mode worker and its delivery poll loop (`channels/index.ts`)
 * pushed onto `loops`. Telegram long-poll and other future channels land the same way — push onto
 * this array, don't touch the boot sequence.
 */
export async function main(): Promise<void> {
  loadEnv({ path: ".env.local" });
  // Retried rather than read once: Turbo starts the API and this process concurrently in `pnpm
  // dev`, and the API needs a database round trip before the file is (re)written — most visibly
  // right after `reset-dev.sh`, where the old file's credential no longer matches the wiped DB.
  // `verify` closes a narrower gap than presence: a stale file from *before* the reset can already
  // be non-empty on this process's very first read, satisfying the missing-keys check moments
  // before the API overwrites it with the real value — so presence alone is not proof of validity.
  const fromVolume = await waitForDataDirEnv({
    attempts: 15,
    delayMs: 1_000,
    onRetry: (missing, attempt) => {
      logger.info(
        `Waiting for ${missing.join(", ")} on the data volume (attempt ${attempt}/15)...`
      );
    },
    verify: async (env) => {
      if (!env.INTEGRATION_WORKER_API_CREDENTIAL || !env.INTERNAL_API_URL) return true;
      try {
        const response = await fetch(`${env.INTERNAL_API_URL}/api/v1/internal/llm/config`, {
          headers: { authorization: `Bearer ${env.INTEGRATION_WORKER_API_CREDENTIAL}` },
        });
        return response.status !== 401;
      } catch {
        return false;
      }
    },
  });
  if (fromVolume.length > 0) {
    logger.info(`Read ${fromVolume.join(", ")} from the data volume.`);
  }

  const config = loadConfig();
  const pool = await connectPg(config.databaseUrl);

  // Fail closed before anything reads a table: the API owns migrations, and this process running
  // ahead of them would read columns that do not exist yet.
  const schemaVersion = await waitForSchemaFloor(pool, REQUIRED_SCHEMA_VERSION, {
    attempts: 31,
    delayMs: 1_000,
    onRetry: (error, attempt) => {
      logger.warn(
        `Waiting for API migrations before integration-worker boot (attempt ${attempt}/31): ${error.message}`
      );
    },
  });

  let serving = true;
  const controller = new AbortController();
  const loops: DrainableLoop[] = [];

  const slackDeps = {
    businessId: config.businessId,
    pool,
    internalApiUrl: config.internalApiUrl,
    internalApiCredential: config.internalApiCredential,
    signal: controller.signal,
    log: logger,
  };
  const slackLoops = await createSlackChannelLoops(slackDeps);
  if (slackLoops.length > 0) {
    loops.push(...slackLoops);
  } else {
    // Slack isn't connected yet: keep polling in the background so connecting it later via the
    // web UI doesn't require restarting this process.
    loops.push(
      watchForSlackChannelCredential(slackDeps, (readyLoops) => loops.push(...readyLoops))
    );
  }

  const probeServer = await startProbeServer({
    port: config.port,
    database: pool,
    requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
    isServing: () => serving,
    areConsumersReady: () => true,
  });

  logger.info(`integration-worker ready: schema=${schemaVersion} port=${config.port}`);

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Readiness fails first so the orchestrator stops routing to this instance while it drains.
    serving = false;
    logger.info(`integration-worker draining (${reason})`);

    // Release the port immediately so a restart right after Ctrl+C doesn't hit EADDRINUSE
    // while the (up to drainTimeoutMs) drain below is still running.
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));

    const outcome = await drain({
      loops,
      abort: () => controller.abort(),
      timeoutMs: config.drainTimeoutMs,
    });

    await pool.end();

    if (outcome.status === "drained") {
      logger.info("integration-worker drained cleanly");
      process.exit(0);
    }
    logger.error(
      `integration-worker drain timed out after ${config.drainTimeoutMs}ms; ` +
        `loops still in flight: ${outcome.pending.join(", ")}.`
    );
    process.exit(1);
  };

  for (const signalName of ["SIGTERM", "SIGINT"] as const) {
    process.on(signalName, () => {
      shutdown(signalName).catch((error: unknown) => {
        // A drain that cannot even run is an unsafe shutdown, and must not look like a clean one.
        logger.error("integration-worker shutdown failed", error);
        process.exit(1);
      });
    });
  }
}

main().catch((error) => {
  console.error(
    `❌ Integration worker boot failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
