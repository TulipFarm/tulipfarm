import { randomUUID } from "node:crypto";
import { RunLeaseManager, RunResumeGateway, WaitTimerSweeper } from "@tulipfarm/run-kernel";
import {
  loadActiveDek,
  loadEncryptionKeys,
  PgDekRepo,
  PgSecretRepo,
  SecretsService,
} from "@tulipfarm/secrets";
import { BudgetStore, EventStore, RunEventStore, RunStore, WaitStore } from "@tulipfarm/storage";
import { config as loadEnv } from "dotenv";
import { loadConfig, REQUIRED_SCHEMA_VERSION, type WorkerConfig } from "./config";
import { connectPg, transactionPort } from "./db";
import { DeliveryTargetRegistry } from "./delivery";
import { EventOutboxDispatcher } from "./event-dispatcher";
import { RunExecutorRegistry } from "./executors";
import { createHookExecutor } from "./hooks/executor";
import { InternalApiClient } from "./internal/client";
import { HttpDeliveryHost } from "./internal/delivery-host";
import { HttpTurnHost } from "./internal/turn-host";
import { SoulLlm } from "./llm";
import { type LoopLogger, runLoop } from "./loop";
import { LlmModelPort } from "./model";
import { assertSchemaFloor } from "./preflight";
import { startProbeServer } from "./probe-server";
import { RunDispatcher } from "./run-dispatcher";
import { type DrainableLoop, drain } from "./shutdown";
import { createChatExecutor } from "./turn/chat-executor";
import { createIntegrationExecutor } from "./turn/integration-executor";
import { RunStoreStateTransitions } from "./turn/kernel-ports";

/** Consumer identity recorded on every outbox receipt this process writes. */
const OUTBOX_CONSUMER = "worker.run-dispatch";

/**
 * The Run source the Chat executor owns, as `DurableInvocationGateway` records it on the bundle.
 * Slack and Telegram requests reach the same executor because the ingress path derives a chat
 * request from the envelope — the executor never learns which channel asked.
 */
const CHAT_RUN_SOURCE = "chat";

/**
 * The Run source an Integration delivery is minted under.
 *
 * Its executor classifies the stored envelope and then hands the Run to the very same chat
 * executor, so a Slack message and a web message are answered by one code path — the difference
 * between them ends at the classifier.
 */
const INTEGRATION_RUN_SOURCE = "integration";

const logger = {
  info: (message: string) => console.log(message),
  // A guard that timed out or threw is skipped rather than allowed to stall the turn, so this is
  // the only place it is ever heard about.
  warn: (obj: unknown, message?: string) =>
    message === undefined ? console.warn(obj) : console.warn(message, obj),
  error: (message: string, error?: unknown) =>
    error === undefined ? console.error(message) : console.error(message, error),
} satisfies LoopLogger & {
  info: (message: string) => void;
  warn: (obj: unknown, message?: string) => void;
};

/**
 * Composition root for the durable worker.
 *
 * Three loops run side by side. Run dispatch claims queued Runs and drives them to a terminal
 * status. The wait sweep resolves durable waits whose deadline passed and requeues their Runs.
 * Outbox delivery drains accepted integration events to their targets. Each is independent: a
 * failing loop backs off on its own without stopping the others, because a stuck delivery target
 * must not stop Runs from progressing.
 */
export async function main(): Promise<void> {
  loadEnv({ path: ".env.local" });

  const config: WorkerConfig = loadConfig();
  const pool = await connectPg(config.databaseUrl);

  // Fail closed before a single Run is claimed: the API owns migrations, and a worker running
  // ahead of them would write columns that do not exist yet.
  const schemaVersion = await assertSchemaFloor(pool, REQUIRED_SCHEMA_VERSION);

  const transactions = transactionPort(pool);
  const runStore = new RunStore(transactions);
  const waitStore = new WaitStore(transactions);
  const eventStore = new EventStore(transactions, randomUUID);
  const runEventStore = new RunEventStore(transactions);
  const budgetStore = new BudgetStore(transactions);

  const leases = new RunLeaseManager(runStore);
  const resume = new RunResumeGateway(runStore);
  const sweeper = new WaitTimerSweeper(waitStore, resume);

  // The turn host answers every question a turn has that this process cannot answer itself: which
  // Turn a Run answers, the assembled Context, Tool dispatch, and the durable completion.
  const internalApi = new InternalApiClient({
    baseUrl: config.internalApiUrl,
    credential: config.internalApiCredential,
  });
  const turnHost = new HttpTurnHost(internalApi);

  // The Soul's LLM configuration names providers and `api_key_ref`s; the credentials themselves are
  // unwrapped here, against this worker's own database, so no key material crosses the API hop.
  // `loadActiveDek`, never `loadOrProvision*`: the API mints keys, exactly as it owns migrations.
  const llm = new SoulLlm({
    source: () => turnHost.llmConfig(),
    secrets: async () =>
      new SecretsService(
        new PgSecretRepo(pool),
        await loadActiveDek(new PgDekRepo(pool), loadEncryptionKeys())
      ),
  });

  const executors = new RunExecutorRegistry();
  const deliveryTargets = new DeliveryTargetRegistry();

  const chatExecutor = createChatExecutor({
    host: turnHost,
    context: turnHost,
    runs: runStore,
    events: runEventStore,
    budgets: budgetStore,
    transitions: new RunStoreStateTransitions(runStore),
    waits: turnHost,
    model: new LlmModelPort({ model: (id) => llm.model(id) }),
    log: logger,
  });
  executors.register(CHAT_RUN_SOURCE, chatExecutor);

  executors.register(
    INTEGRATION_RUN_SOURCE,
    createIntegrationExecutor({
      deliveries: new HttpDeliveryHost(internalApi),
      // Spawned once and shared: the isolate is stateless between calls and its circuit breaker is
      // per-Integration, so a classifier that keeps failing is disabled for that Integration rather
      // than rediscovered from scratch on every delivery.
      hooks: createHookExecutor(),
      events: runEventStore,
      turn: chatExecutor,
    })
  );

  const runDispatcher = new RunDispatcher({
    leases,
    businessId: config.businessId,
    owner: config.owner,
    handler: (run) => executors.execute(run),
    now: () => new Date(),
    leaseDurationMs: config.leaseDurationMs,
    batchSize: config.batchSize,
  });

  const outboxDispatcher = new EventOutboxDispatcher({
    outbox: eventStore,
    businessId: config.businessId,
    owner: config.owner,
    consumer: OUTBOX_CONSUMER,
    handler: (message) => deliveryTargets.deliver(message),
    now: () => new Date().toISOString(),
    leaseDurationMs: config.leaseDurationMs,
    batchSize: config.batchSize,
  });

  const controller = new AbortController();
  const { signal } = controller;
  let serving = true;

  const loops: DrainableLoop[] = [
    {
      name: "run-dispatch",
      settled: runLoop({
        name: "run-dispatch",
        intervalMs: config.runPollMs,
        tick: async () => {
          await runDispatcher.dispatchBatch();
        },
        signal,
        logger,
      }),
    },
    {
      name: "wait-sweep",
      settled: runLoop({
        name: "wait-sweep",
        intervalMs: config.waitSweepMs,
        tick: async () => {
          await sweeper.sweep({
            businessId: config.businessId,
            now: new Date(),
            limit: config.batchSize,
          });
        },
        signal,
        logger,
      }),
    },
    {
      name: "outbox-delivery",
      settled: runLoop({
        name: "outbox-delivery",
        intervalMs: config.outboxPollMs,
        tick: async () => {
          await outboxDispatcher.dispatchBatch();
        },
        signal,
        logger,
      }),
    },
  ];

  const probeServer = await startProbeServer({
    port: config.port,
    database: pool,
    requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
    isServing: () => serving,
  });

  logger.info(
    `worker ready: owner=${config.owner} business=${config.businessId} ` +
      `schema=${schemaVersion} port=${config.port} ` +
      `executors=${executors.size} deliveryTargets=${deliveryTargets.size}`
  );

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Readiness fails first so the orchestrator stops routing to this instance while it drains.
    serving = false;
    logger.info(`worker draining (${reason})`);

    const outcome = await drain({
      loops,
      abort: () => controller.abort(),
      timeoutMs: config.drainTimeoutMs,
    });

    await new Promise<void>((resolve) => probeServer.close(() => resolve()));
    await pool.end();

    if (outcome.status === "drained") {
      logger.info("worker drained cleanly");
      process.exit(0);
    }
    logger.error(
      `worker drain timed out after ${config.drainTimeoutMs}ms; ` +
        `loops still in flight: ${outcome.pending.join(", ")}. ` +
        "Their Run leases will be reclaimed on expiry."
    );
    process.exit(1);
  };

  for (const signalName of ["SIGTERM", "SIGINT"] as const) {
    process.on(signalName, () => {
      shutdown(signalName).catch((error: unknown) => {
        // A drain that cannot even run is an unsafe shutdown, and must not look like a clean one.
        logger.error("worker shutdown failed", error);
        process.exit(1);
      });
    });
  }
}

main().catch((error) => {
  console.error(`❌ Worker boot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
