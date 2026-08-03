import { config as loadEnv } from "dotenv";
import { loadConfig, REQUIRED_SCHEMA_VERSION } from "./config";
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
 * Boot skeleton only: proves the process shape (schema-floor wait, `/livez`+`/readyz`, drain on
 * `SIGTERM`) before any dispatch logic exists. `loops` starts empty — no consumer (Slack Socket
 * Mode, Telegram long-poll, delivery retry) is registered yet; each lands in its own PR and only
 * has to push onto this array, not touch the boot sequence.
 */
export async function main(): Promise<void> {
  loadEnv({ path: ".env.local" });

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

    const outcome = await drain({
      loops,
      abort: () => controller.abort(),
      timeoutMs: config.drainTimeoutMs,
    });

    await new Promise<void>((resolve) => probeServer.close(() => resolve()));
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
