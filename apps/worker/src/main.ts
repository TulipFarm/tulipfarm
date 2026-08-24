import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  BatchingLogSink,
  describeError,
  MutationKillSwitchGuard,
  PgLogWriter,
  PgResourceWriter,
  processResourceProbe,
  ResourceSampler,
} from "@tulipfarm/observability";
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
  type SecretsService,
} from "@tulipfarm/secrets";
import { PgBundleStore } from "@tulipfarm/soul";
import {
  ArtifactStore,
  BudgetStore,
  createBlobPort,
  EventStore,
  IntegrationStore,
  KillSwitchRepo,
  listUsersWithDueWork,
  RunEventStore,
  RunLoopCheckpointStore,
  RunStateConcurrencyStore,
  RunStateContentionStore,
  RunStateRetryStore,
  RunStore,
  TaskRepo,
  WaitStore,
} from "@tulipfarm/storage";
import { PgEffectStore } from "@tulipfarm/tool-broker";
import { createChatExecutor, RunStoreStateTransitions } from "@tulipfarm/turn-executor";
import { config as loadEnv } from "dotenv";
import { loadConfig, REQUIRED_SCHEMA_VERSION, type WorkerConfig } from "./config";
import { CURATOR_RUN_SOURCE, createCuratorExecutor } from "./curator/executor";
import { sweepCurator } from "./curator/sweep";
import { resolveDataDir, waitForDataDirEnv } from "./data-dir";
import { connectPg, transactionPort } from "./db";
import { DeliveryTargetRegistry } from "./delivery";
import { createEffortInference, runEventEffortPin } from "./effort-inference";
import { EventOutboxDispatcher } from "./event-dispatcher";
import { RunExecutorRegistry } from "./executors";
import { buildWorkerFileService } from "./files/service";
import { createHookExecutor } from "./hooks/executor";
import { InternalApiClient } from "./internal/client";
import { HttpDeliveryHost } from "./internal/delivery-host";
import { HttpTurnHost } from "./internal/turn-host";
import { SoulLlm } from "./llm";
import { type LoopLogger, runLoop } from "./loop";
import { startMaintenanceConsumers } from "./maintenance";
import { LlmModelPort } from "./model";
import { MODEL_BUDGET_EXHAUSTION_POLICY } from "./model-budget";
import { ProviderGate } from "./model-gate";
import { PgSpendSink } from "./observability";
import { waitForSchemaFloor } from "./preflight";
import { startProbeServer } from "./probe-server";
import { TaskSignalsGatherer } from "./reconcile/task-signals";
import { buildGitHubTooling } from "./routine/adapters";
import { BundleRoutineAgentPort } from "./routine/agent-port";
import { HttpRoutineApprovalPort } from "./routine/approval-port";
import { WorkerRoutineDefinitionLoader } from "./routine/definition-loader";
import { createRoutineExecutor } from "./routine/executor";
import { WorkerPinnedDefinitionReader } from "./routine/pinned-definitions";
import { buildBundleSandboxAdapters } from "./routine/sandbox-tooling";
import { BrokerRoutineToolPort } from "./routine/tool-port";
import { RunDispatcher } from "./run-dispatcher";
import { GuardedWorkerSecretsService } from "./secrets-guard";
import { type DrainableLoop, drain } from "./shutdown";
import { createToolResultDistiller } from "./tool-result-distiller";
import { buildLocalToolHost } from "./tools/local-host";
import { RoutingToolDispatch } from "./tools/routing-dispatch";
import { SoulEmbeddings } from "./tools/soul-embeddings";
import { createIntegrationExecutor } from "./turn/integration-executor";

/** Consumer identity recorded on every outbox receipt this process writes. */
const OUTBOX_CONSUMER = "worker.run-dispatch";

/** Chat source; channel-specific ingress derives a normal chat request before this executor. */
const CHAT_RUN_SOURCE: RunSource = "chat";

/** Integration deliveries classify first, then use the same chat executor. */
const INTEGRATION_RUN_SOURCE: RunSource = "integration";

/** Routine Runs execute only from their exact immutable bundle in this process. */
const ROUTINE_RUN_SOURCE: RunSource = "routine";

/** Attached after the pool exists; stdout remains the fallback. */
let logSink: BatchingLogSink | null = null;

function captureError(message: string, error?: unknown): void {
  if (!logSink) return;
  const detail = error === undefined ? null : describeError(error);
  logSink.capture({
    level: "error",
    // Both halves matter: the call site's message says what was attempted, the error what failed.
    message: detail && detail.message !== message ? `${message}: ${detail.message}` : message,
    stack: detail?.stack ?? null,
  });
}

const logger = {
  info: (message: string) => console.log(message),
  // Timed-out or thrown guards are skipped; this is their only report.
  warn: (obj: unknown, message?: string) =>
    message === undefined ? console.warn(obj) : console.warn(message, obj),
  error: (message: string, error?: unknown) => {
    if (error === undefined) console.error(message);
    else console.error(message, error);
    captureError(message, error);
  },
} satisfies LoopLogger & {
  info: (message: string) => void;
  warn: (obj: unknown, message?: string) => void;
};

/** Composition root; each loop backs off independently so one failure does not stop the others. */
export async function main(): Promise<void> {
  loadEnv({ path: ".env.local" });
  // Env wins; otherwise retry data-volume reads because API and Worker boot concurrently.
  // `verify` rejects stale pre-reset credentials that are present but no longer authenticate.
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
        // An unreachable API means the readiness probe has not cleared yet.
        return false;
      }
    },
  });
  if (fromVolume.length > 0) {
    logger.info(`Read ${fromVolume.join(", ")} from the data volume.`);
  }

  const config: WorkerConfig = loadConfig();
  const pool = await connectPg(config.databaseUrl);

  // Fail closed before claiming Runs; API owns migrations.
  const schemaVersion = await waitForSchemaFloor(pool, REQUIRED_SCHEMA_VERSION, {
    attempts: 31,
    delayMs: 1_000,
    onRetry: (error, attempt) => {
      logger.warn(
        `Waiting for API migrations before worker boot (attempt ${attempt}/31): ${error.message}`
      );
    },
  });

  // Telemetry is not load-bearing: missing log tables degrade to stdout, not boot failure.
  logSink = new BatchingLogSink({ service: "worker", writer: new PgLogWriter(pool) });
  logSink.start();

  // Match resource samples to the same owner used for Run leases.
  const resourceSampler = new ResourceSampler({
    service: "worker",
    instance: config.owner,
    probe: processResourceProbe(process),
    writer: new PgResourceWriter(pool),
  });
  resourceSampler.start();

  const transactions = transactionPort(pool);
  const internalApi = new InternalApiClient({
    baseUrl: config.internalApiUrl,
    credential: config.internalApiCredential,
  });
  const turnHost = new HttpTurnHost(internalApi);

  const killSwitchRepo = new KillSwitchRepo(transactions);
  // The API owns the audit ledger, so a Worker-side denial leaves its evidence in the Run's own
  // event history plus this log line; the stop itself is enforced identically either way.
  const mutationGuard = new MutationKillSwitchGuard({
    listEnabled: (businessId) => killSwitchRepo.listEnabled(businessId),
    audit: {
      record: async (evidence) => {
        logger.warn(
          `kill switch ${evidence.switchId} (${evidence.scopeKind}) denied effect ${evidence.effectId ?? "?"}: ${evidence.reasonCode}`
        );
      },
    },
  });
  const runStore = new RunStore(transactions);
  const waitStore = new WaitStore(transactions);
  const eventStore = new EventStore(transactions, randomUUID);
  const runEventStore = new RunEventStore(transactions);
  const budgetStore = new BudgetStore(transactions);
  // Durable Agent-loop counters: the one store both Agent-loop sites share, so an approval park
  // reloads spent Tool-call and repair budget instead of restarting it at zero.
  const loopCheckpointStore = new RunLoopCheckpointStore(transactions);
  // Durable per-State-occurrence retry counter, so a Routine State's `retry` budget is not
  // refunded when the State parks and resumes or the Run crashes and is reclaimed.
  const stateRetryStore = new RunStateRetryStore(transactions);
  // Durable mutual exclusion for a Routine State's `concurrencyKey`. Contenders are in other
  // worker processes, so only a shared durable lease actually serializes what the author asked
  // not to overlap; an in-process store would serialize this worker and nothing else.
  const stateConcurrencyStore = new RunStateConcurrencyStore(transactions);
  // Durable backoff budget for a contender on that key. It has to outlive the park it pays for:
  // a counter reloaded as zero would give every resume a fresh ceiling and turn a bounded queue
  // into an unbounded one.
  const stateContentionStore = new RunStateContentionStore(transactions);
  const blobs = createBlobPort(join(resolveDataDir() ?? ".tulipfarm", "blobs"));
  const artifactService = new ArtifactService(
    new ArtifactStore(transactions),
    new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS),
    blobs
  );

  const leases = new RunLeaseManager(runStore);
  const resume = new RunResumeGateway(runStore);
  const sweeper = new WaitTimerSweeper(waitStore, resume);
  // Routine timers open here; the same sweeper resolves them.
  const waits = new DurableWaitManager(waitStore, resume);

  // API mints keys; Worker only loads the active DEK and memoizes the secret service.
  let secretsService: Promise<SecretsService> | undefined;
  const secrets = async () =>
    (secretsService ??= (async () =>
      new GuardedWorkerSecretsService(
        new PgSecretRepo(pool),
        await loadActiveDek(new PgDekRepo(pool), loadEncryptionKeys())
      ))());
  const llm = new SoulLlm({
    source: () => turnHost.llmConfig(),
    secrets,
    pricingOverrides: () => turnHost.pricingOverrides(),
  });

  // Built from the same published config the control plane embeds with, and rebuilt before each
  // vector-backed answer, so a co-located ranking cannot quietly diverge from the remote one.
  const localEmbeddings = new SoulEmbeddings({
    source: () => turnHost.llmConfig(),
    secrets,
    log: logger,
  });

  let consumersReady = !config.maintenance;
  const jobBoss = config.maintenance
    ? await startMaintenanceConsumers({
        databaseUrl: config.databaseUrl,
        pool,
        transactions,
        businessId: config.businessId,
        log: logger,
        turnHost,
        internalApi,
        blobs,
        embeddings: localEmbeddings,
      })
    : undefined;
  consumersReady = true;

  // Tools that need no live Soul, no renderer and no provider credential run here, next to the
  // Run they belong to; everything else still dispatches over the control plane.
  const localTools = buildLocalToolHost({
    db: pool,
    transactions,
    artifacts: artifactService,
    waits,
    embeddings: localEmbeddings,
    // `file_create` renders here, not in the API: model-authored content is untrusted input.
    blobs,
  });
  const toolDispatch = new RoutingToolDispatch(localTools, turnHost, turnHost, logger);

  const executors = new RunExecutorRegistry();
  const deliveryTargets = new DeliveryTargetRegistry();

  // Installation scope only; GitHubAdapter narrows until Soul-authored AccessGrants exist.
  const githubTooling = buildGitHubTooling({
    businessId: config.businessId,
    integrations: new IntegrationStore(transactions),
    secrets,
    log: logger,
  });
  // Local sandbox images are dev-only; production fails closed until a remote backend is wired.
  const sandboxRuntimeImage =
    process.env.NODE_ENV === "production" ? undefined : process.env.SANDBOX_RUNTIME_IMAGE;

  // Declared before the executors so every per-turn model port can be aborted on drain.
  // Both port constructions previously omitted it, leaving production model calls unbounded.
  const controller = new AbortController();
  const { signal } = controller;

  // One per process, shared by every turn: a per-turn gate would cap nothing.
  const modelGate = new ProviderGate();

  // The spend ledger the dashboard reads. Without this the Worker charges Run budgets correctly
  // and reports nothing, so every cost view showed zero.
  const spendSink = new PgSpendSink(pool, logger);

  // The intermediary the network Tools deliberately do not contain: `web_fetch` and `api_request`
  // return whole responses, and the judgement about which parts matter happens once, here, on the
  // cheapest rung, against what the Turn actually asked.
  // Built per Turn, not once: this is a real provider call, and the case for making it here
  // rather than inside the Tool rests on it being attributed and gated like any other.
  const toolResultDistiller = ({
    runId,
    conversationId,
  }: {
    runId: string;
    conversationId: string;
  }) =>
    createToolResultDistiller({
      models: llm,
      log: logger,
      spend: spendSink,
      gate: modelGate,
      attribution: { runId, conversationId },
    });

  const chatExecutor = createChatExecutor({
    host: turnHost,
    distiller: toolResultDistiller,
    tools: toolDispatch,
    context: turnHost,
    attachments: turnHost,
    runs: runStore,
    events: runEventStore,
    budgets: budgetStore,
    transitions: new RunStoreStateTransitions(runStore),
    waits: turnHost,
    checkpoints: loopCheckpointStore,
    model: ({ events, budgets, businessId, runId, conversationId }) =>
      new LlmModelPort({
        model: (selector, requirements, inference, principal, gate) =>
          llm.resolveModel(selector, requirements, inference, principal, gate),
        signal,
        gate: modelGate,
        spend: spendSink,
        conversationId,
        effort: createEffortInference({
          models: llm,
          pinned: runEventEffortPin(runEventStore, businessId, runId),
          log: (decision) =>
            logger.info(
              `effort routed run=${runId} rung=${decision.rung} score=${decision.score} band=${decision.band} classifier=${decision.usedClassifier} prompt=${decision.promptHash} signals=${decision.firedSignals.join("+")}`
            ),
        }),
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
    spend: spendSink,
    log: logger,
  });
  executors.register(CHAT_RUN_SOURCE, chatExecutor);

  executors.register(
    CURATOR_RUN_SOURCE,
    createCuratorExecutor({
      api: internalApi,
      models: { model: (selector, requirements) => llm.model(selector, requirements) },
      artifacts: artifactService,
      runs: runStore,
      transitions: new RunStoreStateTransitions(runStore),
      log: logger,
    })
  );

  executors.register(
    INTEGRATION_RUN_SOURCE,
    createIntegrationExecutor({
      deliveries: new HttpDeliveryHost(internalApi),
      // Shared isolate; circuit breakers stay per Integration.
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
      // Durable retry budget for a State's authored `retry` policy; survives park/resume and crash.
      retries: stateRetryStore,
      // Durable, cross-worker exclusion for a State's authored `concurrencyKey`.
      concurrency: stateConcurrencyStore,
      // Durable backoff budget, so a contended key queues on a timer instead of an operator.
      contention: stateContentionStore,
      waits,
      // Routine Tools must pass the Broker: pinned authority, ledger reservation, then adapter.
      // No `authority` callback: the bundle layer is the Run's only authority.
      tools: new BrokerRoutineToolPort({
        effects: new PgEffectStore(transactions),
        adapters: githubTooling.adapters,
        adaptersFor: (request) =>
          buildBundleSandboxAdapters(request, {
            artifacts: artifactService,
            ...(sandboxRuntimeImage === undefined ? {} : { runtimeImage: sandboxRuntimeImage }),
          }),
        credentials: githubTooling.credentials,
        mutationGuard,
      }),
      // Approval resume tokens stay API-side; Worker gets only wait id and later decision.
      approvals: new HttpRoutineApprovalPort(internalApi),
      // Routine Agent States use the pinned Agent/ModelProfile and expose no Tools.
      agents: new BundleRoutineAgentPort({
        // Chain, routing event, and budget are already selected/opened by the Routine port.
        model: ({ modelIds, routing }) =>
          new LlmModelPort({
            // Through `resolveChain`, so a Routine call is priced by the same authority as a Chat
            // call. Building the resolution inline here is what left Routine spend reported free.
            model: async (_selector, _requirements, _inference, principal, gate) =>
              llm.resolveChain(modelIds, routing, principal, gate),
            signal,
            gate: modelGate,
            spend: spendSink,
          }),
        events: runEventStore,
        budgets: budgetStore,
        runs: runStore,
        checkpoints: loopCheckpointStore,
        log: logger,
      }),
    })
  );

  const runDispatcher = new RunDispatcher({
    leases,
    businessId: config.businessId,
    owner: config.owner,
    // Every co-located Tool call this process makes happens inside this handler and is awaited
    // by it, so its settlement — succeeded, failed, parked on a wait, cancelled, or thrown — is
    // the one point where no further dispatch can follow for this Run. Evicting here bounds the
    // authority cache by in-flight Runs instead of by process lifetime, and covers terminal
    // paths this worker never observes: a Run abandoned, cancelled, or reconciled while parked
    // was already forgotten when it parked.
    handler: async (run) => {
      try {
        return await executors.execute(run);
      } finally {
        toolDispatch.forget(run.id);
      }
    },
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
    serving = false;
    consumersReady = false;
    logger.info(`worker draining (${reason})`);

    // Release the port before the drain so immediate restarts avoid EADDRINUSE.
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));

    const outcome = await drain({
      loops,
      abort: () => {
        controller.abort();
        stopJobConsumers();
      },
      timeoutMs: config.drainTimeoutMs,
    });

    if (outcome.status !== "drained") {
      logger.error(
        `worker drain timed out after ${config.drainTimeoutMs}ms; ` +
          `loops still in flight: ${outcome.pending.join(", ")}. ` +
          "Their Run leases will be reclaimed on expiry."
      );
    }

    // Stop samplers before pool.end(); a timed-out drain must still be recorded.
    await resourceSampler.stop();
    await logSink?.stop();
    await pool.end();

    if (outcome.status === "drained") {
      logger.info("worker drained cleanly");
      process.exit(0);
    }
    process.exit(1);
  };

  for (const signalName of ["SIGTERM", "SIGINT"] as const) {
    process.on(signalName, () => {
      shutdown(signalName).catch(async (error: unknown) => {
        logger.error("worker shutdown failed", error);
        // Best effort: if the pool is closed, this degrades to stderr.
        await resourceSampler.stop();
        await logSink?.stop();
        process.exit(1);
      });
    });
  }
}

main().catch((error) => {
  console.error(`❌ Worker boot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
