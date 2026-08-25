import { RunLeaseManager, type RunLeaseStore } from "@tulipfarm/run-kernel";
import type { PersistedRun, PersistedRunStatus } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { RunDispatcher, type RunDispatcherOptions, type RunOutcome } from "./run-dispatcher";

const BUSINESS_ID = "business-1";

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
    ...overrides,
  };
}

class FakeRunStore implements RunLeaseStore {
  releaseCalls: unknown[] = [];
  releaseResult = true;
  claimBatchResult: readonly PersistedRun[] = [];
  reclaimResult: readonly PersistedRun[] = [];

  async transitionRun(
    _businessId: string,
    _runId: string,
    transition: {
      expectedVersion: number;
      expectedStatus: PersistedRunStatus;
      status: PersistedRunStatus;
      leaseOwner: string | null;
      leaseExpiresAt: string | null;
    }
  ): Promise<boolean> {
    if (transition.leaseOwner === null) {
      this.releaseCalls.push(transition);
      return this.releaseResult;
    }
    return true;
  }

  async heartbeat(): Promise<boolean> {
    return true;
  }

  async reclaimExpiredRuns(): Promise<readonly PersistedRun[]> {
    return this.reclaimResult;
  }

  async claimNextQueued(): Promise<readonly PersistedRun[]> {
    return this.claimBatchResult;
  }

  async find(_businessId: string, runId: string): Promise<PersistedRun | null> {
    return persistedRun({ id: runId, status: "running", version: 2 });
  }
}

describe("RunDispatcher", () => {
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
        return "succeeded";
      },
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({ reclaimed: 0, claimed: 1, dispatched: 1, waiting: 0, failed: 0 });
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
      handler: async () => "waiting",
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({ reclaimed: 0, claimed: 1, dispatched: 0, waiting: 1, failed: 0 });
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
      handler: async () => "cancelled",
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({ reclaimed: 0, claimed: 1, dispatched: 0, waiting: 1, failed: 0 });
    expect(store.releaseCalls).toEqual([]);
  });

  it("releases to needs_reconciliation when the handler throws", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    const leases = new RunLeaseManager(store);
    const dispatcher = new RunDispatcher({
      leases,
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: async () => {
        throw new Error("boom");
      },
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({ reclaimed: 0, claimed: 1, dispatched: 0, waiting: 0, failed: 1 });
    expect(store.releaseCalls).toEqual([
      expect.objectContaining({ status: "needs_reconciliation" }),
    ]);
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
      handler: async () => "succeeded",
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toEqual({ reclaimed: 0, claimed: 1, dispatched: 0, waiting: 0, failed: 0 });
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
      handler: async () => "succeeded",
    });

    await expect(dispatcher.dispatchBatch()).resolves.toEqual({
      reclaimed: 0,
      claimed: 1,
      dispatched: 0,
      waiting: 0,
      failed: 1,
    });
  });

  describe("onTerminal", () => {
    function dispatcherWith(
      outcome: RunOutcome,
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
        handler: async () => outcome,
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

    it("keeps the Run terminal when the hook throws", async () => {
      const dispatcher = dispatcherWith("succeeded", async () => {
        throw new Error("signal transport down");
      });

      await expect(dispatcher.dispatchBatch()).resolves.toEqual({
        reclaimed: 0,
        claimed: 1,
        dispatched: 1,
        waiting: 0,
        failed: 0,
      });
    });
  });

  describe("onWaiting", () => {
    function dispatcherWith(
      outcome: RunOutcome,
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
          handler: async () => outcome,
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
        claimed: 1,
        dispatched: 0,
        waiting: 1,
        failed: 0,
      });
    });
  });
});
