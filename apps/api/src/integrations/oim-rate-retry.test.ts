import type { PGlite } from "@electric-sql/pglite";
import {
  ConnectionResolver,
  type EgressHttpPort,
  type IntegrationHttpResponse,
  OimOperationConnectionResolver,
} from "@tulipfarm/integrations";
import { DurableWaitManager, RunResumeGateway, WaitTimerSweeper } from "@tulipfarm/run-kernel";
import type { OimManifest, ToolContractDefinition } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import { RunStore, WaitStore } from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  EffectDispatcher,
  EffectLedger,
  PgEffectStore,
  type ToolAdapter,
  ToolCatalog,
} from "@tulipfarm/tool-broker";
import { InMemoryToolCatalog, RegistryToolDispatcher } from "@tulipfarm/tool-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Queryable, transactionPort } from "../db";
import { makeMigratedPglite } from "../test/pglite";
import { buildDeclarativeTools } from "../tools/declarative/tools";
import { OimRateRetryWaitHost, oimRateRetryWaitId } from "./oim-rate-retry";
import { createOimReleaseDispatchHost } from "./releases/dispatch-host";

const BUSINESS_ID = "business-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";
const STATE_KEY = "invoke";
const LOGICAL_EFFECT_STATE = "chat:call-1";
const RETRY_AT = "2026-09-07T06:30:20.000Z";
const AUTHORITY = {
  businessId: BUSINESS_ID,
  runId: RUN_ID,
  turn: {
    conversationId: "44444444-4444-4444-8444-444444444444",
    id: "55555555-5555-4555-8555-555555555555",
    attempt: 1,
  },
  subject: { kind: "user" as const, id: "user-1" },
  source: "chat" as const,
  bundleDigest: "sha256:bundle-1",
};

function rateLimitedIntegration(): SoulIntegration {
  const manifest = {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      description: "Weather forecast",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "forecast",
        name: "forecast",
        description: "Read the forecast",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/forecast",
        },
        rateLimit: { retryAfterHeader: "retry-after" },
        response: {
          schema: {
            type: "object",
            properties: { temperature: { type: "number" } },
            required: ["temperature"],
            additionalProperties: false,
          },
          maxBytes: 16_384,
        },
      },
    ],
  } as OimManifest;
  return { slug: "weather", sourceIntegration: "weather", oimManifest: manifest };
}

function publicConnections() {
  return new OimOperationConnectionResolver(
    new ConnectionResolver(
      {
        findById: async () => null,
        listForOwner: async () => [],
        listForIntegration: async () => [],
      },
      { canUse: async () => true }
    ),
    { list: async () => [] }
  );
}

const definition: ToolContractDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "ToolContract",
  metadata: {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "weather-forecast",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "active",
    publishedDigest: "a".repeat(64),
  },
  spec: {
    toolId: "weather.forecast",
    toolVersion: "1.0.0",
    action: "weather.forecast",
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["temperature"],
      properties: { temperature: { type: "number" } },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: ["public"],
    allowedDestinations: ["api.weather.example"],
    idempotency: { strategy: "none" },
    retry: { maxAttempts: 2, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: "weather" },
  },
};

describe("OimRateRetryWaitHost", () => {
  let database: PGlite;
  let runs: RunStore;

  beforeEach(async () => {
    database = await makeMigratedPglite();
    runs = new RunStore(transactionPort(database as unknown as Queryable));
    await runs.start({
      id: RUN_ID,
      businessId: BUSINESS_ID,
      source: "chat",
      bundle: {
        digest: "sha256:bundle-1",
        routineId: "assistant",
        routineVersion: "1",
      },
      identity: {
        initiator: { kind: "user", id: "user-1" },
        effectiveSubject: { kind: "user", id: "user-1" },
        guardrailContextRef: "guardrail-1",
      },
      createdAt: "2026-09-07T06:30:00.000Z",
      states: [
        {
          key: STATE_KEY,
          definitionRef: "sha256:bundle-1#/states/invoke",
          resolvedInput: {},
        },
      ],
    });
    await runs.transitionRun(BUSINESS_ID, RUN_ID, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-09-07T06:31:00.000Z",
    });
    await runs.transitionRun(BUSINESS_ID, RUN_ID, {
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "running",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-09-07T06:31:00.000Z",
    });
  });

  afterEach(async () => {
    await database.close();
  });

  it("resumes the same authorized effect after a restart and one durable timer", async () => {
    const transactions = transactionPort(database as unknown as Queryable);
    const effects = new PgEffectStore(transactions);
    await new EffectLedger(effects).reserve({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: LOGICAL_EFFECT_STATE,
      logicalEffectOrdinal: 1,
      idempotencyKey: "forecast-1",
      intentDigest: "b".repeat(64),
      intent: {
        intentId: "intent-1",
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        stateId: LOGICAL_EFFECT_STATE,
        runStateId: STATE_KEY,
        toolId: "weather.forecast",
        toolVersion: "1.0.0",
        action: "weather.forecast",
        targetRefs: [],
        arguments: {},
        destination: "api.weather.example",
        idempotencyKey: "forecast-1",
      },
      guardrailRevision: "guardrail-1",
      createdAt: "2026-09-07T06:30:00.000Z",
    });

    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi
        .fn()
        .mockRejectedValueOnce(
          new AdapterDispatchError(
            "after_dispatch",
            "provider_rate_limited",
            true,
            undefined,
            20_000
          )
        )
        .mockResolvedValueOnce({ temperature: 21 }),
    };
    const waits = new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs));
    const retryHost = new OimRateRetryWaitHost(waits);
    const dispatcher = new EffectDispatcher({
      store: effects,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([["weather", adapter]]),
      parkRetry: retryHost.parkRetry,
      retryWaitStatus: retryHost.status,
      now: () => "2026-09-07T06:30:00.000Z",
    });

    await expect(dispatcher.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toMatchObject({
      deferred: { effectId: EFFECT_ID, attempt: 1, notBefore: RETRY_AT },
    });
    expect(await effects.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "authorized" });
    expect(await retryHost.status(BUSINESS_ID, EFFECT_ID, 1)).toMatchObject({
      status: "pending",
    });
    await expect(
      new WaitStore(transactions).find(BUSINESS_ID, oimRateRetryWaitId(EFFECT_ID, 1))
    ).resolves.toMatchObject({ stateKey: STATE_KEY });

    await runs.transitionRun(BUSINESS_ID, RUN_ID, {
      expectedVersion: 2,
      expectedStatus: "running",
      status: "waiting",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    const restartedTransactions = transactionPort(database as unknown as Queryable);
    const restartedRuns = new RunStore(restartedTransactions);
    const restartedWaits = new DurableWaitManager(
      new WaitStore(restartedTransactions),
      new RunResumeGateway(restartedRuns)
    );
    const restartedRetryHost = new OimRateRetryWaitHost(restartedWaits);
    const sweeper = new WaitTimerSweeper(
      new WaitStore(restartedTransactions),
      new RunResumeGateway(restartedRuns)
    );

    expect(
      await sweeper.sweep({
        businessId: BUSINESS_ID,
        now: new Date("2026-09-07T06:30:19.999Z"),
        limit: 10,
      })
    ).toEqual([]);
    expect(await restartedRuns.find(BUSINESS_ID, RUN_ID)).toMatchObject({ status: "waiting" });

    expect(
      await sweeper.sweep({
        businessId: BUSINESS_ID,
        now: new Date(RETRY_AT),
        limit: 10,
      })
    ).toEqual([
      expect.objectContaining({
        resumed: true,
        wait: expect.objectContaining({ runId: RUN_ID, status: "satisfied" }),
      }),
    ]);
    expect(await restartedRuns.find(BUSINESS_ID, RUN_ID)).toMatchObject({ status: "queued" });
    expect(await restartedRetryHost.status(BUSINESS_ID, EFFECT_ID, 1)).toMatchObject({
      status: "ready",
    });

    const restartedEffects = new PgEffectStore(restartedTransactions);
    await expect(
      new EffectDispatcher({
        store: restartedEffects,
        catalog: ToolCatalog.load([definition]),
        adapters: new Map([["weather", adapter]]),
        parkRetry: restartedRetryHost.parkRetry,
        retryWaitStatus: restartedRetryHost.status,
        now: () => RETRY_AT,
      }).dispatch(BUSINESS_ID, EFFECT_ID)
    ).resolves.toEqual({ temperature: 21 });

    expect(adapter.dispatch).toHaveBeenCalledTimes(2);
    expect(await restartedEffects.listAttempts(BUSINESS_ID, EFFECT_ID)).toHaveLength(2);
    const effectCount = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM effect_records WHERE business_id = $1 AND effect_id = $2",
      [BUSINESS_ID, EFFECT_ID]
    );
    expect(effectCount.rows[0]?.count).toBe("1");
  });

  it("resumes the same real Chat Tool occurrence after restart without dispatching before due", async () => {
    const transactions = transactionPort(database as unknown as Queryable);
    const effects = new PgEffectStore(transactions);
    const waits = new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs));
    const retryHost = new OimRateRetryWaitHost(waits);
    let requests = 0;
    const http: EgressHttpPort = {
      async send(): Promise<IntegrationHttpResponse> {
        requests += 1;
        if (requests === 1) {
          return { status: 429, headers: { "retry-after": "20" }, body: { error: "busy" } };
        }
        return { status: 200, headers: {}, body: { temperature: 21 } };
      },
    };
    const makeDispatcher = (
      effectStore: PgEffectStore,
      host: OimRateRetryWaitHost
    ): RegistryToolDispatcher => {
      const integration = rateLimitedIntegration();
      const releaseDispatch = createOimReleaseDispatchHost({
        bundled: [{ manifest: integration.oimManifest as OimManifest }],
        activation: {
          async uninstallStatus() {
            throw new Error("bundled release must not read uninstall state");
          },
          trust: {
            async authorizeInstalledRelease() {
              throw new Error("bundled release must not read installed provenance");
            },
          },
          dispatchLeases: {
            async acquire() {
              throw new Error("bundled release must not acquire a dispatch lease");
            },
            async complete() {
              throw new Error("bundled release must not complete a dispatch lease");
            },
            async releaseNotDispatched() {
              throw new Error("bundled release must not release a dispatch lease");
            },
            async markReconciliationRequired() {
              throw new Error("bundled release must not reconcile a dispatch lease");
            },
          },
        },
      });
      const tooling = buildDeclarativeTools([integration], {
        businessId: BUSINESS_ID,
        releaseDispatch,
        effects: effectStore,
        secrets: async () => {
          throw new Error("public Tool must not read Secrets");
        },
        http,
        connections: publicConnections(),
        parkRetry: host.parkRetry,
        retryWaitStatus: host.status,
      });
      const registry = new InMemoryToolCatalog();
      for (const tool of tooling.tools) registry.register(tool);
      return new RegistryToolDispatcher({
        registry,
        artifacts: { read: async () => ({ content: {} }) } as never,
        preparation: tooling.preparation,
      });
    };
    const call = {
      callId: "call-rate-retry",
      stateId: STATE_KEY,
      name: "weather_forecast",
      arguments: {},
    };
    const dispatcher = makeDispatcher(effects, retryHost);

    const first = await dispatcher.dispatch(AUTHORITY, call);
    expect(first).toMatchObject({ status: "awaiting_retry", waitId: expect.any(String) });
    if (first.status !== "awaiting_retry") throw new Error("expected retry wait");
    const persistedWait = await new WaitStore(transactions).find(BUSINESS_ID, first.waitId);
    if (persistedWait === null) throw new Error("expected persisted retry wait");
    expect(requests).toBe(1);
    const [effect] = await effects.list(BUSINESS_ID);
    if (effect === undefined) throw new Error("expected effect");
    expect(effect).toMatchObject({ state: "authorized", stateId: "chat:call-rate-retry" });

    await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toEqual(first);
    expect(requests).toBe(1);

    await runs.transitionRun(BUSINESS_ID, RUN_ID, {
      expectedVersion: 2,
      expectedStatus: "running",
      status: "waiting",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const restartedTransactions = transactionPort(database as unknown as Queryable);
    const restartedRuns = new RunStore(restartedTransactions);
    const restartedWaits = new DurableWaitManager(
      new WaitStore(restartedTransactions),
      new RunResumeGateway(restartedRuns)
    );
    const restartedRetryHost = new OimRateRetryWaitHost(restartedWaits);
    const sweeper = new WaitTimerSweeper(
      new WaitStore(restartedTransactions),
      new RunResumeGateway(restartedRuns)
    );
    await sweeper.sweep({
      businessId: BUSINESS_ID,
      now: new Date(persistedWait.deadlineAt),
      limit: 10,
    });

    await expect(
      makeDispatcher(new PgEffectStore(restartedTransactions), restartedRetryHost).dispatch(
        AUTHORITY,
        call
      )
    ).resolves.toMatchObject({ status: "succeeded", output: { temperature: 21 } });
    expect(requests).toBe(2);
    expect(await effects.listAttempts(BUSINESS_ID, effect.effectId)).toHaveLength(2);
  });
});
