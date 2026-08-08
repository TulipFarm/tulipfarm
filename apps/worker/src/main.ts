import { randomUUID } from "node:crypto";
import {
  ArtifactService,
  DurableWaitManager,
  RoutineStateScheduler,
  RunLeaseManager,
  RunResumeGateway,
  type RunSource,
  TypedOutputValidator,
  WaitTimerSweeper,
} from "@tulipfarm/run-kernel";
import { INVOCATION_REQUEST_SCHEMAS } from "@tulipfarm/schema";
import {
  loadActiveDek,
  loadEncryptionKeys,
  PgDekRepo,
  PgSecretRepo,
  SecretsService,
} from "@tulipfarm/secrets";
import { PgBundleStore } from "@tulipfarm/soul";
import {
  ArtifactStore,
  BudgetStore,
  EventStore,
  IntegrationStore,
  RunEventStore,
  RunStore,
  WaitStore,
} from "@tulipfarm/storage";
import { PgEffectStore } from "@tulipfarm/tool-broker";
import { config as loadEnv } from "dotenv";
import { loadConfig, REQUIRED_SCHEMA_VERSION, type WorkerConfig } from "./config";
import { waitForDataDirEnv } from "./data-dir";
import { connectPg, transactionPort } from "./db";
import { DeliveryTargetRegistry } from "./delivery";
import { EventOutboxDispatcher } from "./event-dispatcher";
import { RunExecutorRegistry } from "./executors";
import { createHookExecutor } from "./hooks/executor";
import { InternalApiClient } from "./internal/client";
import { HttpDeliveryHost } from "./internal/delivery-host";
import { HttpTurnHost } from "./internal/turn-host";
import { startJobConsumers } from "./job-consumers";
import { SoulLlm } from "./llm";
import { type LoopLogger, runLoop } from "./loop";
import { LlmModelPort } from "./model";
import { MODEL_BUDGET_EXHAUSTION_POLICY } from "./model-budget";
import { waitForSchemaFloor } from "./preflight";
import { startProbeServer } from "./probe-server";
import { buildGitHubTooling } from "./routine/adapters";
import { BundleRoutineAgentPort } from "./routine/agent-port";
import { HttpRoutineApprovalPort } from "./routine/approval-port";
import { WorkerRoutineDefinitionLoader } from "./routine/definition-loader";
import { createRoutineExecutor } from "./routine/executor";
import { WorkerPinnedDefinitionReader } from "./routine/pinned-definitions";
import { BrokerRoutineToolPort } from "./routine/tool-port";
import { RunDispatcher } from "./run-dispatcher";
import { type DrainableLoop, drain } from "./shutdown";
import { createChatExecutor } from "./turn/chat-executor";
import { createIntegrationExecutor } from "./turn/integration-executor";
import { RunStoreStateTransitions } from "./turn/kernel-ports";

/** Consumer identity recorded on every outbox receipt this process writes. */
const OUTBOX_CONSUMER = "worker.run-dispatch";

/**
 * The Run source the Chat executor owns, persisted independently from its pinned Routine identity.
 * Slack and Telegram requests reach the same executor because the ingress path derives a chat
 * request from the envelope — the executor never learns which channel asked.
 */
const CHAT_RUN_SOURCE: RunSource = "chat";

/**
 * The Run source an Integration delivery is minted under.
 *
 * Its executor classifies the stored envelope and then hands the Run to the very same chat
 * executor, so a Slack message and a web message are answered by one code path — the difference
 * between them ends at the classifier.
 */
const INTEGRATION_RUN_SOURCE: RunSource = "integration";

/** Routine Runs execute only from their exact immutable bundle in this process. */
const ROUTINE_RUN_SOURCE: RunSource = "routine";

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
 * Run dispatch, wait sweeping, and outbox delivery run side by side. A maintenance replica also
 * owns the pg-boss consumer loop. Each is independent: a failing loop backs off on its own without
 * stopping the others, because a stuck delivery target must not stop Runs from progressing.
 */
export async function main(): Promise<void> {
  loadEnv({ path: ".env.local" });
  // The API mints the credential and the KEK on its first boot and persists them to the shared
  // data volume; without this, a compose deployment that was never handed an `.env` cannot claim a
  // single Run. Env always wins, so a managed deployment never reads the volume at all.
  // Retried rather than read once: Turbo starts the API and this worker concurrently in `pnpm
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
      if (!env.WORKER_API_CREDENTIAL || !env.INTERNAL_API_URL) return true;
      try {
        const response = await fetch(`${env.INTERNAL_API_URL}/api/v1/internal/llm/config`, {
          headers: { authorization: `Bearer ${env.WORKER_API_CREDENTIAL}` },
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

  const config: WorkerConfig = loadConfig();
  const pool = await connectPg(config.databaseUrl);

  // Fail closed before a single Run is claimed: the API owns migrations, and a worker running
  // ahead of them would write columns that do not exist yet.
  const schemaVersion = await waitForSchemaFloor(pool, REQUIRED_SCHEMA_VERSION, {
    attempts: 31,
    delayMs: 1_000,
    onRetry: (error, attempt) => {
      logger.warn(
        `Waiting for API migrations before worker boot (attempt ${attempt}/31): ${error.message}`
      );
    },
  });
  let consumersReady = !config.maintenance;
  const jobBoss = config.maintenance
    ? await startJobConsumers({ databaseUrl: config.databaseUrl, database: pool })
    : undefined;
  consumersReady = true;

  const transactions = transactionPort(pool);
  const runStore = new RunStore(transactions);
  const waitStore = new WaitStore(transactions);
  const eventStore = new EventStore(transactions, randomUUID);
  const runEventStore = new RunEventStore(transactions);
  const budgetStore = new BudgetStore(transactions);
  const artifactService = new ArtifactService(
    new ArtifactStore(transactions),
    new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS)
  );

  const leases = new RunLeaseManager(runStore);
  const resume = new RunResumeGateway(runStore);
  const sweeper = new WaitTimerSweeper(waitStore, resume);
  // Routine `wait` States open their timers here rather than over the internal API: nothing on the
  // far side decides a timer, and the same sweeper above is what resolves it.
  const waits = new DurableWaitManager(waitStore, resume);

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
  // Memoized: every consumer below (LLM keys, the GitHub installation-token provider) shares one
  // instance rather than each re-running the DEK unwrap on its own first call.
  let secretsService: Promise<SecretsService> | undefined;
  const secrets = async () =>
    (secretsService ??= (async () =>
      new SecretsService(
        new PgSecretRepo(pool),
        await loadActiveDek(new PgDekRepo(pool), loadEncryptionKeys())
      ))());
  const llm = new SoulLlm({
    source: () => turnHost.llmConfig(),
    secrets,
  });

  const executors = new RunExecutorRegistry();
  const deliveryTargets = new DeliveryTargetRegistry();

  // Installation-scope-only for this phase (see routine/github-context.ts): the real narrowing is
  // `GitHubAdapter`'s own installation-scope check, not a Soul-authored AccessGrant yet.
  const githubTooling = buildGitHubTooling({
    businessId: config.businessId,
    integrations: new IntegrationStore(transactions),
    secrets,
    log: logger,
  });

  const chatExecutor = createChatExecutor({
    host: turnHost,
    context: turnHost,
    runs: runStore,
    events: runEventStore,
    budgets: budgetStore,
    transitions: new RunStoreStateTransitions(runStore),
    waits: turnHost,
    model: ({ events, budgets, businessId, runId }) =>
      new LlmModelPort({
        model: (selector, requirements) => llm.resolveModel(selector, requirements),
        routingEvents: events,
        budgets: {
          open: (limits) =>
            budgets.open({
              businessId,
              runId,
              limits,
              exhaustionPolicy: MODEL_BUDGET_EXHAUSTION_POLICY,
            }),
        },
      }),
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

  executors.register(
    ROUTINE_RUN_SOURCE,
    createRoutineExecutor({
      definitions: new WorkerRoutineDefinitionLoader(
        new WorkerPinnedDefinitionReader(new PgBundleStore(transactions), secrets)
      ),
      artifacts: artifactService,
      runs: runStore,
      scheduler: new RoutineStateScheduler(runStore),
      transitions: new RunStoreStateTransitions(runStore),
      waits,
      // Every Tool a Routine dispatches goes through the Broker: it authorizes against the Run's
      // own pinned Guardrails and its own pinned ToolContracts' declared actions/resources
      // (`BrokerRoutineToolPort.authorityFor` — the Routine's authority can never widen past what
      // it declares wanting to call), reserves the effect in the ledger, and only then calls an
      // adapter. GitHub is the only installed-Integration context with an owner in this process
      // today; any other adapter ref still parks for reconciliation on `adapter_not_found` — there
      // is no second path to an external effect here. No `authority` callback is passed: the
      // bundle-derived layer above is this Run's only authority, and each adapter's own
      // AccessGrant check narrows further still.
      tools: new BrokerRoutineToolPort({
        effects: new PgEffectStore(transactions),
        adapters: githubTooling.adapters,
        credentials: githubTooling.credentials,
      }),
      // An `approval` State parks on a durable wait registered by the API, in the same transaction
      // as the approval a human will see. The resume token stays there; this process learns the
      // wait's id, and later the decision.
      approvals: new HttpRoutineApprovalPort(internalApi),
      // An `agent` State runs the same bounded loop a chat turn runs, against the Agent and
      // ModelProfile the Run's own bundle names. It exposes no Tools: a Routine's effects belong to
      // its `tool` States, where the Broker authorizes and the ledger reserves them.
      agents: new BundleRoutineAgentPort({
        // The chain is already selected — against the Run's pinned bundle, by the port itself — so
        // this only builds the providers to run it. Routing events and budgets are deliberately
        // unset: the Routine port emits `model.routed` and opens the ModelProfile's Run budget
        // itself, and wiring them here would double both.
        model: ({ modelIds, routing }) =>
          new LlmModelPort({
            model: async () => ({
              kind: "available",
              model: await llm.chainModel(modelIds),
              routing,
            }),
          }),
        events: runEventStore,
        budgets: budgetStore,
        runs: runStore,
        log: logger,
      }),
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

  let stopJobConsumers = (): void => {};
  if (jobBoss) {
    const settled = new Promise<void>((resolve, reject) => {
      stopJobConsumers = () => {
        jobBoss.stop({ graceful: true }).then(resolve, reject);
      };
    });
    loops.push({ name: "pg-boss-consumers", settled });
  }

  const probeServer = await startProbeServer({
    port: config.port,
    database: pool,
    requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
    isServing: () => serving,
    areConsumersReady: () => consumersReady,
  });

  logger.info(
    `worker ready: owner=${config.owner} business=${config.businessId} ` +
      `schema=${schemaVersion} port=${config.port} ` +
      `executors=${executors.size} deliveryTargets=${deliveryTargets.size} ` +
      `maintenance=${config.maintenance}`
  );

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Readiness fails first so the orchestrator stops routing to this instance while it drains.
    serving = false;
    consumersReady = false;
    logger.info(`worker draining (${reason})`);

    // Release the port immediately so a restart right after Ctrl+C doesn't hit EADDRINUSE
    // while the (up to drainTimeoutMs) drain below is still running.
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));

    const outcome = await drain({
      loops,
      abort: () => {
        controller.abort();
        stopJobConsumers();
      },
      timeoutMs: config.drainTimeoutMs,
    });

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
