import { RunLeaseManager, type RunLeaseStore } from "@tulipfarm/run-kernel";
import {
  DISPATCH_REQUEUE_EXHAUSTED_REF,
  DISPATCH_REQUEUED_ONCE_REF,
  type PersistedRun,
  type PersistedRunStatus,
} from "@tulipfarm/storage";
import type { RunOutcomeStatus } from "@tulipfarm/turn-executor";
import { describe, expect, it, vi } from "vitest";
import { RunDispatcher, type RunDispatcherOptions, type RunOutcome } from "./run-dispatcher";

const BUSINESS_ID = "business-1";

function timerWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

function persistedRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    businessId: BUSINESS_ID,
    source: "routine",
    bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "agent", id: "agent-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    status: "claimed",
    version: 1,
    createdAt: "2026-07-24T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    leaseGeneration: 1,
    ...overrides,
  };
}

class FakeRunStore implements RunLeaseStore {
  releaseCalls: unknown[] = [];
  releaseResult = true;
  releaseErrorRunIds = new Set<string>();
  claimBatchResult: PersistedRun[] = [];
  claimBatchCalls: Array<{ owner: string; limit: number }> = [];
  heartbeatCalls: Array<{ owner: string; expectedVersion: number }> = [];
  heartbeatResults: boolean[] = [];
  reclaimResult: readonly PersistedRun[] = [];
  requeueParkedCalls: { businessId: string; limit: number }[] = [];
  requeueParkedResult: readonly PersistedRun[] = [];
  /** Applied to whatever `find` returns, so a test can stage the Run the dispatcher re-reads. */
  findOverrides: Partial<PersistedRun> = {};

  async transitionRun(
    _businessId: string,
    _runId: string,
    transition: {
      expectedVersion: number;
      expectedStatus: PersistedRunStatus;
      status: PersistedRunStatus;
      leaseOwner: string | null;
      leaseExpiresAt: string | null;
      startedAt?: string;
      finishedAt?: string;
      errorEvidenceRef?: string;
    }
  ): Promise<boolean> {
    if (transition.leaseOwner === null) {
      if (this.releaseErrorRunIds.delete(_runId)) {
        throw new Error(`release failed for ${_runId}`);
      }
      this.releaseCalls.push(transition);
      return this.releaseResult;
    }
    return true;
  }

  async heartbeat(
    _businessId: string,
    _runId: string,
    owner: string,
    heartbeat: { expectedVersion: number }
  ): Promise<boolean> {
    this.heartbeatCalls.push({ owner, expectedVersion: heartbeat.expectedVersion });
    return this.heartbeatResults.shift() ?? true;
  }

  async reclaimExpiredRuns(): Promise<readonly PersistedRun[]> {
    return this.reclaimResult;
  }

  async requeueParkedRuns(businessId: string, limit: number): Promise<readonly PersistedRun[]> {
    this.requeueParkedCalls.push({ businessId, limit });
    return this.requeueParkedResult;
  }

  async claimNextQueued(
    _businessId: string,
    owner: string,
    input: { limit: number }
  ): Promise<readonly PersistedRun[]> {
    this.claimBatchCalls.push({ owner, limit: input.limit });
    return this.claimBatchResult.splice(0, input.limit);
  }

  async find(_businessId: string, runId: string): Promise<PersistedRun | null> {
    return persistedRun({ id: runId, status: "running", version: 2, ...this.findOverrides });
  }
}

describe("RunDispatcher", () => {
  it("starts more than four blocked Runs and renews every owned lease", async () => {
    vi.useFakeTimers();
    const drain = new AbortController();
    const store = new FakeRunStore();
    store.claimBatchResult = ["one", "two", "three", "four", "five", "six", "next-poll"].map((id) =>
      persistedRun({ id })
    );
    const started: string[] = [];
    const aborted: string[] = [];
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      batchSize: 6,
      leaseDurationMs: 300,
      now: () => new Date(),
      handler: async (run, signal) => {
        started.push(run.id);
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted.push(run.id);
              resolve();
            },
            { once: true }
          )
        );
        return { status: "cancelled" };
      },
    });
    const running = dispatcher.run({
      intervalMs: 1_000,
      wait: timerWait,
      signal: drain.signal,
      logger: { error: vi.fn() },
    });
    try {
      await vi.waitFor(() => expect(started).toHaveLength(6));
      await vi.advanceTimersByTimeAsync(100);

      expect(started).toEqual(["one", "two", "three", "four", "five", "six"]);
      expect(store.heartbeatCalls).toHaveLength(6);
      expect(store.claimBatchResult.map((run) => run.id)).toEqual(["next-poll"]);
      expect(store.claimBatchCalls.every((call) => call.limit === 1)).toBe(true);
    } finally {
      drain.abort();
      await running;
      expect(aborted.sort()).toEqual(["five", "four", "one", "six", "three", "two"]);
      vi.useRealTimers();
    }
  });

  it("admits newly queued Runs while earlier Runs remain blocked", async () => {
    vi.useFakeTimers();
    const drain = new AbortController();
    const store = new FakeRunStore();
    store.claimBatchResult = ["one", "two"].map((id) => persistedRun({ id }));
    const started: string[] = [];
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      batchSize: 2,
      now: () => new Date(),
      handler: async (run, signal) => {
        started.push(run.id);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
        return { status: "cancelled" };
      },
    });
    const running = dispatcher.run({
      intervalMs: 10,
      wait: timerWait,
      signal: drain.signal,
      logger: { error: vi.fn() },
    });
    try {
      await vi.waitFor(() => expect(started).toHaveLength(2));
      store.claimBatchResult.push(persistedRun({ id: "later" }));
      await vi.advanceTimersByTimeAsync(10);

      expect(started).toEqual(["one", "two", "later"]);
      expect(store.claimBatchResult).toHaveLength(0);
    } finally {
      drain.abort();
      await running;
      vi.useRealTimers();
    }
  });

  it("keeps admitting after one Run fails outside its handler", async () => {
    vi.useFakeTimers();
    const drain = new AbortController();
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun({ id: "bad" })];
    store.releaseErrorRunIds.add("bad");
    const started: string[] = [];
    const logger = { error: vi.fn() };
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      batchSize: 1,
      now: () => new Date(),
      handler: async (run) => {
        started.push(run.id);
        return { status: "succeeded" };
      },
    });
    const running = dispatcher.run({
      intervalMs: 10,
      wait: timerWait,
      signal: drain.signal,
      logger,
    });
    try {
      await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
      store.claimBatchResult.push(persistedRun({ id: "good" }));
      await vi.advanceTimersByTimeAsync(10);

      expect(started).toEqual(["bad", "good"]);
      expect(store.releaseCalls).toEqual([
        expect.objectContaining({ expectedVersion: 2, status: "succeeded" }),
      ]);
    } finally {
      drain.abort();
      await running;
      vi.useRealTimers();
    }
  });

  it("waits for an abort-ignoring handler before reporting a clean drain", async () => {
    const drain = new AbortController();
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    let finish: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    let aborted = false;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      batchSize: 1,
      now: () => new Date(),
      handler: async (_run, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        markStarted?.();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { status: "cancelled" };
      },
    });
    const running = dispatcher.run({
      intervalMs: 10,
      signal: drain.signal,
      logger: { error: vi.fn() },
    });

    await started;
    drain.abort();
    await Promise.resolve();
    expect(aborted).toBe(true);

    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    finish?.();
    await running;
  });

  it("makes one empty claim attempt per poll instead of spinning", async () => {
    vi.useFakeTimers();
    const drain = new AbortController();
    const store = new FakeRunStore();
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date(),
      handler: async () => ({ status: "succeeded" }),
    });
    const running = dispatcher.run({
      intervalMs: 10,
      wait: timerWait,
      signal: drain.signal,
      logger: { error: vi.fn() },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(store.claimBatchCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(store.claimBatchCalls).toHaveLength(2);
    } finally {
      drain.abort();
      await running;
      vi.useRealTimers();
    }
  });

  it("drives a claimed Run through running to succeeded", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    const leases = new RunLeaseManager(store);
    const dispatched: string[] = [];
    const dispatcher = new RunDispatcher({
      leases,
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async (run) => {
        dispatched.push(run.id);
        return { status: "succeeded" };
      },
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({
      reclaimed: 0,
      requeuedParked: 0,
      claimed: 1,
      dispatched: 1,
      waiting: 0,
      failed: 0,
    });
    expect(dispatched).toEqual([persistedRun().id]);
    expect(store.releaseCalls).toEqual([
      expect.objectContaining({ status: "succeeded", leaseOwner: null, leaseExpiresAt: null }),
    ]);
  });

  it("parks a Run that stopped on a durable wait instead of finishing it", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async () => ({ status: "waiting" }),
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({
      reclaimed: 0,
      requeuedParked: 0,
      claimed: 1,
      dispatched: 0,
      waiting: 1,
      failed: 0,
    });
    expect(store.releaseCalls).toEqual([
      expect.objectContaining({ status: "waiting", leaseOwner: null, leaseExpiresAt: null }),
    ]);
  });

  it("leaves a cancelled Run untouched, so it cannot race the cancellation manager", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async () => ({ status: "cancelled" }),
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({
      reclaimed: 0,
      requeuedParked: 0,
      claimed: 1,
      dispatched: 0,
      waiting: 1,
      failed: 0,
    });
    expect(store.releaseCalls).toEqual([]);
  });

  it("releases to needs_reconciliation when the handler throws, logging and recording the reason", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    const leases = new RunLeaseManager(store);
    const logged: Array<{ message: string; error: unknown }> = [];
    const boom = new Error("boom");
    const dispatcher = new RunDispatcher({
      leases,
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      log: {
        error: (message, error) => {
          logged.push({ message, error });
        },
      },
      handler: async () => {
        throw boom;
      },
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({
      reclaimed: 0,
      requeuedParked: 0,
      claimed: 1,
      dispatched: 0,
      waiting: 0,
      failed: 1,
    });
    expect(store.releaseCalls).toEqual([
      expect.objectContaining({
        status: "needs_reconciliation",
        errorEvidenceRef: "dispatch:handler_error",
      }),
    ]);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.error).toBe(boom);
    expect(logged[0]?.message).toContain(persistedRun().id);
    expect(logged[0]?.message).toContain(BUSINESS_ID);
  });

  it("skips a Run whose lease was lost before it could advance to running", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    const leases = new RunLeaseManager(store);
    store.transitionRun = async () => false;
    const dispatcher = new RunDispatcher({
      leases,
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async () => ({ status: "succeeded" }),
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({
      reclaimed: 0,
      requeuedParked: 0,
      claimed: 1,
      dispatched: 0,
      waiting: 0,
      failed: 0,
    });
  });

  it("does not report success when the terminal compare-and-swap loses the lease", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    store.releaseResult = false;
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async () => ({ status: "succeeded" }),
    });

    await expect(dispatcher.dispatchBatch()).resolves.toEqual({
      reclaimed: 0,
      requeuedParked: 0,
      claimed: 1,
      dispatched: 0,
      waiting: 0,
      failed: 1,
    });
  });

  describe("onTerminal", () => {
    function dispatcherWith(
      status: RunOutcomeStatus,
      onTerminal: RunDispatcherOptions["onTerminal"],
      releaseResult = true
    ) {
      const store = new FakeRunStore();
      store.claimBatchResult = [persistedRun()];
      store.releaseResult = releaseResult;
      return new RunDispatcher({
        leases: new RunLeaseManager(store),
        businessId: BUSINESS_ID,
        owner: "worker-1",
        now: () => new Date("2026-07-24T10:00:00.000Z"),
        handler: async (): Promise<RunOutcome> => ({ status }),
        onTerminal,
      });
    }

    it.each([["succeeded"], ["failed"]] as const)(
      "fires for a Run that durably reached %s",
      async (outcome) => {
        const seen: string[] = [];
        const dispatcher = dispatcherWith(outcome, async (run, status) => {
          seen.push(`${run.id}:${status}`);
        });

        await dispatcher.dispatchBatch();

        expect(seen).toEqual([`${persistedRun().id}:${outcome}`]);
      }
    );

    it.each([["waiting"], ["cancelled"]] as const)(
      "does not fire for a %s Run, which is still live",
      async (outcome) => {
        const seen: string[] = [];
        const dispatcher = dispatcherWith(outcome, async (run, status) => {
          seen.push(`${run.id}:${status}`);
        });

        await dispatcher.dispatchBatch();

        expect(seen).toEqual([]);
      }
    );

    it("does not fire when the terminal compare-and-swap lost the lease", async () => {
      const seen: string[] = [];
      const dispatcher = dispatcherWith(
        "succeeded",
        async (run, status) => {
          seen.push(`${run.id}:${status}`);
        },
        false
      );

      await dispatcher.dispatchBatch();

      expect(seen).toEqual([]);
    });

    it("clears terminal replay state only after the Run is durably settled", async () => {
      const store = new FakeRunStore();
      store.claimBatchResult = [persistedRun()];
      const cleared: unknown[][] = [];
      const dispatcher = new RunDispatcher({
        leases: new RunLeaseManager(store),
        checkpoints: {
          settle: async (...args) => {
            expect(store.releaseCalls).toHaveLength(1);
            cleared.push(args);
          },
        },
        businessId: BUSINESS_ID,
        owner: "worker-1",
        now: () => new Date("2026-07-24T10:00:00.000Z"),
        handler: async () => ({ status: "succeeded" }),
      });

      await dispatcher.dispatchBatch();

      expect(cleared).toEqual([
        [BUSINESS_ID, persistedRun().id, undefined, { leaseGeneration: 1 }],
      ]);
    });

    it("keeps the Run terminal when the hook throws", async () => {
      const dispatcher = dispatcherWith("succeeded", async () => {
        throw new Error("signal transport down");
      });

      await expect(dispatcher.dispatchBatch()).resolves.toEqual({
        reclaimed: 0,
        requeuedParked: 0,
        claimed: 1,
        dispatched: 1,
        waiting: 0,
        failed: 0,
      });
    });
  });

  describe("onWaiting", () => {
    function dispatcherWith(
      status: RunOutcomeStatus,
      onWaiting: RunDispatcherOptions["onWaiting"],
      releaseResult = true
    ) {
      const store = new FakeRunStore();
      store.claimBatchResult = [persistedRun()];
      store.releaseResult = releaseResult;
      return {
        store,
        dispatcher: new RunDispatcher({
          leases: new RunLeaseManager(store),
          businessId: BUSINESS_ID,
          owner: "worker-1",
          now: () => new Date("2026-07-24T10:00:00.000Z"),
          handler: async (): Promise<RunOutcome> => ({ status }),
          onWaiting,
        }),
      };
    }

    it("fires only after the Run is durably waiting", async () => {
      // Requeuing is guarded on `runs.status = 'waiting'`, so a hook that ran before the release
      // committed would requeue nothing and leave a Run holding a resolved wait parked forever.
      const releasesAtHook: number[] = [];
      const { store, dispatcher } = dispatcherWith("waiting", async () => {
        releasesAtHook.push(store.releaseCalls.length);
      });

      await dispatcher.dispatchBatch();

      expect(releasesAtHook).toEqual([1]);
    });

    it.each([["succeeded"], ["failed"], ["cancelled"]] as const)(
      "does not fire for a %s Run, which is not parked",
      async (outcome) => {
        const seen: string[] = [];
        const { dispatcher } = dispatcherWith(outcome, async (run) => {
          seen.push(run.id);
        });

        await dispatcher.dispatchBatch();

        expect(seen).toEqual([]);
      }
    );

    it("does not fire when the release to waiting lost the lease", async () => {
      const seen: string[] = [];
      const { dispatcher } = dispatcherWith(
        "waiting",
        async (run) => {
          seen.push(run.id);
        },
        false
      );

      await dispatcher.dispatchBatch();

      expect(seen).toEqual([]);
    });

    it("leaves the Run parked when the hook throws", async () => {
      const { dispatcher } = dispatcherWith("waiting", async () => {
        throw new Error("wait store down");
      });

      await expect(dispatcher.dispatchBatch()).resolves.toEqual({
        reclaimed: 0,
        requeuedParked: 0,
        claimed: 1,
        dispatched: 0,
        waiting: 1,
        failed: 0,
      });
    });
  });

  it("returns Runs parked by a crashed handler to the queue before claiming", async () => {
    const store = new FakeRunStore();
    store.requeueParkedResult = [persistedRun({ status: "queued", version: 2 })];
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      recovery: {
        sweep: async ({ businessId, limit }) => {
          store.requeueParkedCalls.push({ businessId, limit });
          return {
            examined: 1,
            requeued: store.requeueParkedResult.length,
            needsReconciliation: 0,
          };
        },
      },
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async () => ({ status: "succeeded" }),
    });

    const result = await dispatcher.dispatchBatch();

    // Nothing else moves a Run out of `needs_reconciliation`, so without this sweep the Run is
    // parked for good.
    expect(store.requeueParkedCalls).toEqual([{ businessId: BUSINESS_ID, limit: 25 }]);
    expect(result.requeuedParked).toBe(1);
  });

  it("fails a Run that throws again after already being requeued once", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    store.findOverrides = { errorEvidenceRef: DISPATCH_REQUEUED_ONCE_REF };
    const onTerminal = vi.fn();
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async () => {
        throw new Error("boom again");
      },
      onTerminal,
    });

    await dispatcher.dispatchBatch();

    // Parking it again would feed it straight back to the sweep it just came from.
    expect(store.releaseCalls).toEqual([
      expect.objectContaining({
        status: "failed",
        errorEvidenceRef: DISPATCH_REQUEUE_EXHAUSTED_REF,
      }),
    ]);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: persistedRun().id,
        status: "failed",
        errorEvidenceRef: DISPATCH_REQUEUE_EXHAUSTED_REF,
      }),
      "failed"
    );
  });

  it("stamps an unspecified needs_reconciliation outcome so the recovery sweep can see it", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async () => ({ status: "needs_reconciliation" }),
    });

    await dispatcher.dispatchBatch();

    // Without a stamped evidence ref, this Run's `error_evidence_ref` stays null and the recovery
    // sweep's candidate query never selects it, so it parks at `needs_reconciliation` forever.
    expect(store.releaseCalls).toEqual([
      expect.objectContaining({
        status: "needs_reconciliation",
        errorEvidenceRef: "dispatch:unspecified_park",
      }),
    ]);
  });

  it("fails a Run that returns needs_reconciliation again after already being requeued once", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    store.findOverrides = { errorEvidenceRef: DISPATCH_REQUEUED_ONCE_REF };
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async () => ({ status: "needs_reconciliation" }),
    });

    await dispatcher.dispatchBatch();

    // Parking it again would feed it straight back to the sweep it just came from.
    expect(store.releaseCalls).toEqual([
      expect.objectContaining({
        status: "failed",
        errorEvidenceRef: DISPATCH_REQUEUE_EXHAUSTED_REF,
      }),
    ]);
  });

  it.each(["succeeded", "waiting"] as const)(
    "renews a long-running Run and releases %s with the renewed version",
    async (status) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime("2026-07-24T10:00:00.000Z");
        const store = new FakeRunStore();
        store.claimBatchResult = [persistedRun()];
        let finish: ((outcome: RunOutcome) => void) | undefined;
        const dispatcher = new RunDispatcher({
          leases: new RunLeaseManager(store),
          businessId: BUSINESS_ID,
          owner: "worker-1",
          now: () => new Date(),
          leaseDurationMs: 300,
          handler: (_run, signal) =>
            new Promise<RunOutcome>((resolve, reject) => {
              finish = resolve;
              signal.addEventListener("abort", () => reject(new Error("lost lease")), {
                once: true,
              });
            }),
        });

        const dispatching = dispatcher.dispatchBatch();
        await vi.advanceTimersByTimeAsync(100);
        finish?.({ status });
        const result = await dispatching;

        expect(store.heartbeatCalls).toEqual([{ owner: "worker-1", expectedVersion: 2 }]);
        expect(store.releaseCalls).toEqual([
          expect.objectContaining({ expectedVersion: 3, status }),
        ]);
        expect(result[status === "succeeded" ? "dispatched" : "waiting"]).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("aborts the handler and stops the batch when lease renewal loses ownership", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-07-24T10:00:00.000Z");
      const store = new FakeRunStore();
      store.claimBatchResult = [
        persistedRun(),
        persistedRun({ id: "00000000-0000-4000-8000-000000000002" }),
      ];
      store.heartbeatResults = [false];
      const aborted: string[] = [];
      const dispatcher = new RunDispatcher({
        leases: new RunLeaseManager(store),
        businessId: BUSINESS_ID,
        owner: "worker-1",
        now: () => new Date(),
        leaseDurationMs: 300,
        handler: (run, signal) =>
          new Promise<RunOutcome>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted.push(run.id);
                resolve({ status: "cancelled" });
              },
              { once: true }
            );
          }),
      });

      const dispatching = dispatcher.dispatchBatch();
      await vi.advanceTimersByTimeAsync(100);
      const result = await dispatching;

      expect(aborted).toEqual([persistedRun().id]);
      expect(store.releaseCalls).toEqual([]);
      expect(store.claimBatchCalls).toEqual([{ owner: "worker-1", limit: 1 }]);
      expect(result).toMatchObject({ claimed: 1, dispatched: 0, waiting: 0, failed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons an overlong claimed execution for normal lease reclaim", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeRunStore();
      store.claimBatchResult = [persistedRun()];
      let aborted = false;
      const dispatcher = new RunDispatcher({
        leases: new RunLeaseManager(store),
        businessId: BUSINESS_ID,
        owner: "worker-1",
        now: () => new Date(),
        leaseDurationMs: 300,
        maxLifetimeMs: 750,
        handler: (_run, signal) =>
          new Promise<RunOutcome>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve({ status: "cancelled" });
              },
              { once: true }
            );
          }),
      });

      const dispatching = dispatcher.dispatchBatch();
      await vi.advanceTimersByTimeAsync(750);

      await expect(dispatching).resolves.toMatchObject({ claimed: 1, failed: 1 });
      expect(aborted).toBe(true);
      expect(store.releaseCalls).toEqual([]);
      expect(store.heartbeatCalls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a rejected heartbeat as lease loss and always removes the drain listener", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-07-24T10:00:00.000Z");
      const store = new FakeRunStore();
      store.claimBatchResult = [persistedRun()];
      store.heartbeat = async () => {
        throw new Error("database unavailable");
      };
      const drain = new AbortController();
      const removeListener = vi.spyOn(drain.signal, "removeEventListener");
      let toolAborted = false;
      const dispatcher = new RunDispatcher({
        leases: new RunLeaseManager(store),
        businessId: BUSINESS_ID,
        owner: "worker-1",
        now: () => new Date(),
        leaseDurationMs: 300,
        signal: drain.signal,
        handler: (_run, signal) =>
          new Promise<RunOutcome>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                toolAborted = true;
                resolve({ status: "cancelled" });
              },
              { once: true }
            );
          }),
      });

      const dispatching = dispatcher.dispatchBatch();
      await vi.advanceTimersByTimeAsync(100);

      await expect(dispatching).resolves.toMatchObject({
        claimed: 1,
        dispatched: 0,
        waiting: 0,
        failed: 1,
      });
      expect(toolAborted).toBe(true);
      expect(store.releaseCalls).toEqual([]);
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for a stuck heartbeat after process shutdown loses the lease", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-07-24T10:00:00.000Z");
      const store = new FakeRunStore();
      store.claimBatchResult = [persistedRun()];
      store.heartbeat = () => new Promise<boolean>(() => {});
      const drain = new AbortController();
      let started: (() => void) | undefined;
      let finish: ((outcome: RunOutcome) => void) | undefined;
      let aborted = false;
      const handling = new Promise<void>((resolve) => {
        started = resolve;
      });
      const dispatcher = new RunDispatcher({
        leases: new RunLeaseManager(store),
        businessId: BUSINESS_ID,
        owner: "worker-1",
        now: () => new Date(),
        leaseDurationMs: 300,
        signal: drain.signal,
        handler: (_run, signal) =>
          new Promise<RunOutcome>((resolve) => {
            finish = resolve;
            started?.();
            signal.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      });

      const dispatching = dispatcher.dispatchBatch();
      await handling;
      await vi.advanceTimersByTimeAsync(100);
      finish?.({ status: "succeeded" });
      await vi.advanceTimersByTimeAsync(0);
      drain.abort("worker_shutdown");
      let settled = false;
      void dispatching.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      expect(aborted).toBe(true);
      await expect(dispatching).resolves.toMatchObject({ claimed: 1, failed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts active work and leaves its lease fenced during process shutdown", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [
      persistedRun(),
      persistedRun({ id: "00000000-0000-4000-8000-000000000002" }),
    ];
    const drain = new AbortController();
    let started: (() => void) | undefined;
    const handling = new Promise<void>((resolve) => {
      started = resolve;
    });
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      signal: drain.signal,
      handler: (_run, signal) =>
        new Promise<RunOutcome>((resolve) => {
          started?.();
          signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
        }),
    });

    const dispatching = dispatcher.dispatchBatch();
    await handling;
    drain.abort("worker_shutdown");
    const result = await dispatching;

    expect(store.releaseCalls).toEqual([]);
    expect(store.claimBatchCalls).toEqual([{ owner: "worker-1", limit: 1 }]);
    expect(result).toMatchObject({ claimed: 1, failed: 1 });
  });

  it("does not lease later batch work until the current handler settles", async () => {
    const store = new FakeRunStore();
    const secondId = "00000000-0000-4000-8000-000000000002";
    store.claimBatchResult = [persistedRun(), persistedRun({ id: secondId })];
    let finishFirst: (() => void) | undefined;
    const handled: string[] = [];
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async (run) => {
        handled.push(run.id);
        if (run.id === persistedRun().id) {
          await new Promise<void>((resolve) => {
            finishFirst = resolve;
          });
        }
        return { status: "succeeded" };
      },
      batchSize: 2,
    });

    const dispatching = dispatcher.dispatchBatch();
    await vi.waitFor(() => expect(handled).toEqual([persistedRun().id]));
    expect(store.claimBatchCalls).toEqual([{ owner: "worker-1", limit: 1 }]);
    finishFirst?.();
    await dispatching;

    expect(handled).toEqual([persistedRun().id, secondId]);
    expect(store.claimBatchCalls).toEqual([
      { owner: "worker-1", limit: 1 },
      { owner: "worker-1", limit: 1 },
    ]);
  });
});
