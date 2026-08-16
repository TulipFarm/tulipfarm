import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StateTransitionPort } from "../apps/worker/src/agent-state";
import type { RoutineAgentPort } from "../apps/worker/src/routine/agent-port";
import type { LoadedRoutineDefinition } from "../apps/worker/src/routine/definition-loader";
import { createRoutineExecutor } from "../apps/worker/src/routine/executor";
import {
  InMemoryStateConcurrencyStore,
  InMemoryStateContentionStore,
  type RegisterWaitInput,
  RoutineStateScheduler,
  routineConcurrencyWaitId,
  STATE_CONCURRENCY_MAX_WAITS,
  stateConcurrencyBackoffMs,
} from "../packages/run-kernel/src/index";
import { MANUAL_REQUEST_SCHEMA_REF, type routine } from "../packages/schema/src/index";
import type { PersistedRun, PersistedState, PersistedWait } from "../packages/storage/src/index";

/**
 * Fitness function for L3-8: contention for a `concurrencyKey` queues, it does not become an
 * operator's inbox — and queueing never buys that at the cost of the exclusion itself.
 *
 * L3-6 made the key real with a durable lease, and made a contender that could not get it park at
 * `needs_reconciliation`. Nothing requeues a parked Run, so a busy key converted directly into
 * human attention: under real contention the queue was built out of a person. The fix is a durable
 * backoff timer, and the trap in building one is that a State parked on a wait normally resumes by
 * being treated as *finished* — a `tool` State queued that way would come back having skipped its
 * own effect, which is a far worse bug than the one being fixed.
 *
 * These assertions therefore pin three things together, because each is only safe given the other
 * two: two contenders never overlap; a contender queues durably instead of parking; and a fired
 * backoff resumes *into* the State's body rather than past it. The fourth reads the composition,
 * where the durable store cannot be exercised in a unit test.
 */

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();
const MAIN = join(ROOT, "apps/worker/src/main.ts");

const BUSINESS = "business-1";
const KEY = "shared-ledger";
const AT = "2026-08-02T00:00:00.000Z";
const RUN_A = "00000000-0000-4000-8000-0000000000a1";
const RUN_B = "00000000-0000-4000-8000-0000000000b2";

const definition: routine.RoutineDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "00000000-0000-4000-8000-000000000101",
    slug: "post-ledger",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    owner: "agent:assistant",
    start: "Start",
    states: [
      {
        type: "agent",
        name: "Start",
        agentRef: { name: "poster", version: "1" },
        concurrencyKey: KEY,
        end: true,
      } as routine.RoutineState,
    ],
  },
};

function run(id: string): PersistedRun {
  return {
    id,
    businessId: BUSINESS,
    source: "routine",
    bundle: {
      digest: "bundle-digest",
      routineId: "00000000-0000-4000-8000-000000000101",
      routineVersion: "1",
    },
    identity: {
      initiator: { kind: "agent", id: "assistant" },
      effectiveSubject: { kind: "agent", id: "assistant" },
      guardrailContextRef: "guardrail:default",
    },
    bounds: { wallTimeMs: 60_000, activeTimeMs: 30_000, attempts: 3, sideEffects: 0 },
    status: "running",
    version: 2,
    createdAt: AT,
    startedAt: AT,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-08-02T00:01:00.000Z",
  };
}

/** Durable State rows and waits for one Run, with the CAS the `run_states` table enforces. */
class Harness implements StateTransitionPort {
  readonly states = new Map<string, PersistedState>();
  readonly waits = new Map<string, PersistedWait>();
  readonly transitions: string[] = [];

  constructor(readonly runId: string) {
    this.states.set("Start", {
      businessId: BUSINESS,
      runId,
      key: "Start",
      definitionRef: "definition:Start",
      resolvedInput: { payloadRef: `artifact:${runId}:request` },
      status: "pending",
      version: 0,
      createdAt: AT,
      startedAt: null,
      finishedAt: null,
      resultArtifactId: null,
      errorEvidenceRef: null,
    });
  }

  readonly scheduler = new RoutineStateScheduler({
    ensureState: async (input) => {
      const existing = this.states.get(input.key);
      if (existing !== undefined) return { outcome: "existing" as const, state: existing };
      throw new Error(`unexpected schedule of ${input.key}`);
    },
  });

  readonly waitPort = {
    register: async (input: RegisterWaitInput) => {
      if (this.waits.has(input.id)) throw new Error(`duplicate wait ${input.id}`);
      const wait = {
        ...input,
        status: "pending" as const,
        resolvedAt: null,
        version: 0,
      } satisfies PersistedWait;
      this.waits.set(input.id, wait);
      return { wait };
    },
    find: async (_businessId: string, waitId: string) => this.waits.get(waitId) ?? null,
  };

  /** Stands in for the deadline sweep resolving a due timer. */
  fireBackoff(attempt: number): void {
    const id = routineConcurrencyWaitId(this.runId, "Start", attempt);
    const wait = this.waits.get(id);
    if (wait === undefined) throw new Error(`no backoff wait ${attempt}`);
    this.waits.set(id, { ...wait, status: "satisfied", resolvedAt: AT });
  }

  async transition(input: Parameters<StateTransitionPort["transition"]>[0]): Promise<void> {
    const persisted = this.states.get(input.stateKey);
    if (persisted === undefined || persisted.status !== input.from) {
      throw new Error(`transition conflict:${input.stateKey}`);
    }
    this.transitions.push(`${input.from}->${input.to}`);
    this.states.set(input.stateKey, {
      ...persisted,
      status: input.to,
      version: persisted.version + 1,
      errorEvidenceRef: input.reason ?? persisted.errorEvidenceRef,
    });
  }
}

function executorFor(input: {
  harness: Harness;
  agent: RoutineAgentPort;
  concurrency: InMemoryStateConcurrencyStore;
  contention: InMemoryStateContentionStore;
}) {
  return createRoutineExecutor({
    definitions: {
      load: async () =>
        ({
          document: definition,
          bundle: { digest: "bundle-digest" },
        }) as unknown as LoadedRoutineDefinition,
    },
    artifacts: {
      read: async () => ({
        schemaRef: MANUAL_REQUEST_SCHEMA_REF,
        content: { slug: "post-ledger", inputs: {} },
        contentHash: "request-hash",
      }),
    },
    runs: { listStates: async () => [...input.harness.states.values()] },
    scheduler: input.harness.scheduler,
    transitions: input.harness,
    waits: input.harness.waitPort,
    agents: input.agent,
    concurrency: input.concurrency,
    contention: input.contention,
    // Collapses the bounded in-process poll; the durable backoff is what this test is about.
    delay: async () => {},
    now: () => new Date(AT),
  });
}

describe("Routine State concurrencyKey contention queueing (L3-8)", () => {
  it("never lets two contenders for one key overlap", async () => {
    const concurrency = new InMemoryStateConcurrencyStore();
    const contention = new InMemoryStateContentionStore();
    const alpha = new Harness(RUN_A);
    const beta = new Harness(RUN_B);

    let live = 0;
    let peakLive = 0;
    const bodies: string[] = [];
    let releaseAlpha: (() => void) | undefined;
    const alphaHolding = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    let alphaEntered: (() => void) | undefined;
    const alphaInsideBody = new Promise<void>((resolve) => {
      alphaEntered = resolve;
    });

    const body = (label: string, hold: Promise<void> | null): RoutineAgentPort => ({
      execute: async () => {
        live += 1;
        peakLive = Math.max(peakLive, live);
        bodies.push(label);
        alphaEntered?.();
        if (hold !== null) await hold;
        live -= 1;
        return { kind: "succeeded", output: null };
      },
    });

    const runAlpha = executorFor({
      harness: alpha,
      agent: body("alpha", alphaHolding),
      concurrency,
      contention,
    });
    const runBeta = executorFor({
      harness: beta,
      agent: body("beta", null),
      concurrency,
      contention,
    });

    // Alpha takes the key and stalls inside its body, still holding it.
    const alphaSettled = runAlpha(run(RUN_A));
    await alphaInsideBody;
    expect(bodies).toEqual(["alpha"]);

    // Beta contends for the same key while alpha holds it: it must not enter its body.
    await expect(runBeta(run(RUN_B))).resolves.toBe("waiting");
    expect(bodies).toEqual(["alpha"]);

    releaseAlpha?.();
    await expect(alphaSettled).resolves.toBe("succeeded");

    // The sweep fires beta's backoff and the Run is requeued; only now may beta run.
    beta.fireBackoff(1);
    await expect(runBeta(run(RUN_B))).resolves.toBe("succeeded");

    expect(bodies).toEqual(["alpha", "beta"]);
    expect(peakLive).toBe(1);
  });

  it("queues a contended State on a durable timer instead of parking it for an operator", async () => {
    const concurrency = new InMemoryStateConcurrencyStore();
    const contention = new InMemoryStateContentionStore();
    const beta = new Harness(RUN_B);
    await concurrency.acquire({
      businessId: BUSINESS,
      concurrencyKey: KEY,
      runId: RUN_A,
      stateKey: "Start",
      now: AT,
      expiresAt: "2026-08-02T01:00:00.000Z",
    });

    const execute = executorFor({
      harness: beta,
      agent: { execute: async () => ({ kind: "succeeded", output: null }) },
      concurrency,
      contention,
    });
    await expect(execute(run(RUN_B))).resolves.toBe("waiting");

    // `waiting` is swept by machinery that already exists; `needs_reconciliation` is not swept at
    // all, which is exactly why parking here was operator work.
    expect(beta.transitions).toContain("running->waiting");
    expect(beta.transitions).not.toContain("running->needs_reconciliation");
    const wait = beta.waits.get(routineConcurrencyWaitId(RUN_B, "Start", 1));
    expect(wait?.kind).toBe("timer");
    expect(Date.parse(wait?.deadlineAt ?? "")).toBeGreaterThan(Date.parse(AT));
  });

  it("resumes a fired backoff into the State's body, not past it", async () => {
    const concurrency = new InMemoryStateConcurrencyStore();
    const contention = new InMemoryStateContentionStore();
    const beta = new Harness(RUN_B);
    await concurrency.acquire({
      businessId: BUSINESS,
      concurrencyKey: KEY,
      runId: RUN_A,
      stateKey: "Start",
      now: AT,
      expiresAt: "2026-08-02T01:00:00.000Z",
    });

    let bodyRuns = 0;
    const execute = executorFor({
      harness: beta,
      agent: {
        execute: async () => {
          bodyRuns += 1;
          return { kind: "succeeded", output: null };
        },
      },
      concurrency,
      contention,
    });

    await expect(execute(run(RUN_B))).resolves.toBe("waiting");
    expect(bodyRuns).toBe(0);

    await concurrency.release(BUSINESS, KEY, RUN_A, "Start");
    beta.fireBackoff(1);
    await expect(execute(run(RUN_B))).resolves.toBe("succeeded");

    // The bug this guards: a satisfied wait meaning "the State succeeded" would settle the Run
    // with `bodyRuns === 0` — the effect silently skipped.
    expect(bodyRuns).toBe(1);
    expect(beta.transitions).toContain("waiting->ready");
  });

  it("bounds the queue with a durable budget that a resume cannot refund", async () => {
    const concurrency = new InMemoryStateConcurrencyStore();
    const contention = new InMemoryStateContentionStore();
    const beta = new Harness(RUN_B);
    await concurrency.acquire({
      businessId: BUSINESS,
      concurrencyKey: KEY,
      runId: RUN_A,
      stateKey: "Start",
      now: AT,
      expiresAt: "2026-08-02T01:00:00.000Z",
    });

    let bodyRuns = 0;
    const execute = executorFor({
      harness: beta,
      agent: {
        execute: async () => {
          bodyRuns += 1;
          return { kind: "succeeded", output: null };
        },
      },
      concurrency,
      contention,
    });

    for (let pass = 1; pass <= STATE_CONCURRENCY_MAX_WAITS; pass += 1) {
      await expect(execute(run(RUN_B))).resolves.toBe("waiting");
      await expect(contention.load(BUSINESS, RUN_B, "Start")).resolves.toMatchObject({
        waits: pass,
      });
      beta.fireBackoff(pass);
    }
    // At the ceiling the honest answer is still the old one: park, never run unserialized.
    await expect(execute(run(RUN_B))).resolves.toBe("needs_reconciliation");
    expect(bodyRuns).toBe(0);
    expect(beta.states.get("Start")?.errorEvidenceRef).toBe("routine:concurrency_key_busy");
  });

  it("jitters the backoff so contenders woken together do not re-collide", () => {
    const first = stateConcurrencyBackoffMs(3, `${RUN_A}:Start`);
    const second = stateConcurrencyBackoffMs(3, `${RUN_B}:Start`);
    expect(first).not.toBe(second);
    // Deterministic per contender, so a crashed Run recomputes the delay it already committed to.
    expect(stateConcurrencyBackoffMs(3, `${RUN_A}:Start`)).toBe(first);
    // Growing and bounded: never below half the exponential step, never above it.
    for (const attempt of [1, 2, 3, 4, 5, 6]) {
      const delay = stateConcurrencyBackoffMs(attempt, `${RUN_A}:Start`);
      const step = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
      expect(delay).toBeGreaterThanOrEqual(step / 2);
      expect(delay).toBeLessThanOrEqual(step);
    }
  });

  it("wires the durable contention store from the composition root into the routine executor", () => {
    const main = readFileSync(MAIN, "utf8");
    // An in-memory budget is per process, so contenders in other workers would each get a full
    // ceiling and the bound would not be a bound at all.
    expect(main).toMatch(/new RunStateContentionStore\(/);
    expect(main).toMatch(/contention:\s*stateContentionStore\b/);
  });
});
