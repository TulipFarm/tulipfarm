import type { PersistedRun, PersistedRunStatus } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { RunLeaseManager, type RunLeaseStore } from "./lease";
import { RunTransitionError } from "./model";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const BUSINESS_ID = "business-1";

function persistedRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    id: RUN_ID,
    businessId: BUSINESS_ID,
    bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "agent", id: "agent-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    bounds: { wallTimeMs: 60_000, activeTimeMs: 30_000, attempts: 3, sideEffects: 2 },
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
  transitionCalls: unknown[] = [];
  heartbeatCalls: unknown[] = [];
  reclaimCalls: unknown[] = [];
  claimBatchCalls: unknown[] = [];
  transitionResult = true;
  heartbeatResult = true;
  reclaimResult: readonly PersistedRun[] = [];
  claimBatchResult: readonly PersistedRun[] = [];
  foundRun: PersistedRun | null = persistedRun();

  async transitionRun(
    businessId: string,
    runId: string,
    transition: {
      expectedVersion: number;
      expectedStatus: PersistedRunStatus;
      status: PersistedRunStatus;
      leaseOwner: string | null;
      leaseExpiresAt: string | null;
    }
  ): Promise<boolean> {
    this.transitionCalls.push({ businessId, runId, transition });
    return this.transitionResult;
  }

  async heartbeat(
    businessId: string,
    runId: string,
    owner: string,
    heartbeat: { expectedVersion: number; leaseExpiresAt: string }
  ): Promise<boolean> {
    this.heartbeatCalls.push({ businessId, runId, owner, heartbeat });
    return this.heartbeatResult;
  }

  async reclaimExpiredRuns(
    businessId: string,
    now: string,
    limit: number
  ): Promise<readonly PersistedRun[]> {
    this.reclaimCalls.push({ businessId, now, limit });
    return this.reclaimResult;
  }

  async claimNextQueued(
    businessId: string,
    owner: string,
    input: { now: string; leaseDurationMs: number; limit: number }
  ): Promise<readonly PersistedRun[]> {
    this.claimBatchCalls.push({ businessId, owner, input });
    return this.claimBatchResult;
  }

  async find(_businessId: string, _runId: string): Promise<PersistedRun | null> {
    return this.foundRun;
  }
}

describe("RunLeaseManager", () => {
  it("claims a queued Run, computing the lease expiry from now + duration", async () => {
    const store = new FakeRunStore();
    const manager = new RunLeaseManager(store);

    const result = await manager.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: "worker-1",
      now: new Date("2026-07-24T10:00:00.000Z"),
      leaseDurationMs: 60_000,
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
    });

    expect(result).toEqual({ claimed: true, run: persistedRun() });
    expect(store.transitionCalls).toEqual([
      {
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        transition: {
          expectedVersion: 0,
          expectedStatus: "queued",
          status: "claimed",
          leaseOwner: "worker-1",
          leaseExpiresAt: "2026-07-24T10:01:00.000Z",
        },
      },
    ]);
  });

  it("advances an owned claim into running while keeping the lease", async () => {
    const store = new FakeRunStore();
    const manager = new RunLeaseManager(store);

    await manager.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: "worker-1",
      now: new Date("2026-07-24T10:00:30.000Z"),
      leaseDurationMs: 60_000,
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "running",
    });

    expect(store.transitionCalls).toEqual([
      {
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        transition: {
          expectedVersion: 1,
          expectedStatus: "claimed",
          status: "running",
          leaseOwner: "worker-1",
          leaseExpiresAt: "2026-07-24T10:01:30.000Z",
        },
      },
    ]);
  });

  it("does not call storage for an illegal claim transition", async () => {
    const store = new FakeRunStore();
    const manager = new RunLeaseManager(store);

    await expect(
      manager.claim({
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        owner: "worker-1",
        now: new Date("2026-07-24T10:00:00.000Z"),
        leaseDurationMs: 60_000,
        expectedVersion: 0,
        expectedStatus: "succeeded",
        status: "claimed",
      })
    ).rejects.toEqual(new RunTransitionError("invalid_run_transition", "succeeded", "claimed"));
    expect(store.transitionCalls).toEqual([]);
  });

  it("reports an unclaimed lease as not claimed without reading the Run", async () => {
    const store = new FakeRunStore();
    store.transitionResult = false;
    const manager = new RunLeaseManager(store);

    const result = await manager.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: "worker-2",
      now: new Date("2026-07-24T10:00:00.000Z"),
      leaseDurationMs: 60_000,
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
    });

    expect(result).toEqual({ claimed: false, run: null });
  });

  it("releases a claimed lease, clearing the owner and expiry", async () => {
    const store = new FakeRunStore();
    const manager = new RunLeaseManager(store);

    const released = await manager.release({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      expectedVersion: 2,
      expectedStatus: "running",
      status: "succeeded",
    });

    expect(released).toBe(true);
    expect(store.transitionCalls).toEqual([
      {
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        transition: {
          expectedVersion: 2,
          expectedStatus: "running",
          status: "succeeded",
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      },
    ]);
  });

  it("computes the heartbeat's new expiry from now + duration and forwards the owner", async () => {
    const store = new FakeRunStore();
    const manager = new RunLeaseManager(store);

    const ok = await manager.heartbeat({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: "worker-1",
      now: new Date("2026-07-24T10:00:30.000Z"),
      leaseDurationMs: 60_000,
      expectedVersion: 1,
    });

    expect(ok).toBe(true);
    expect(store.heartbeatCalls).toEqual([
      {
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        owner: "worker-1",
        heartbeat: { expectedVersion: 1, leaseExpiresAt: "2026-07-24T10:01:30.000Z" },
      },
    ]);
  });

  it("delegates bulk reclaim with an ISO timestamp", async () => {
    const store = new FakeRunStore();
    store.reclaimResult = [
      persistedRun({ status: "queued", leaseOwner: null, leaseExpiresAt: null }),
    ];
    const manager = new RunLeaseManager(store);

    const reclaimed = await manager.reclaimExpired({
      businessId: BUSINESS_ID,
      now: new Date("2026-07-24T10:01:00.001Z"),
      limit: 10,
    });

    expect(reclaimed).toEqual(store.reclaimResult);
    expect(store.reclaimCalls).toEqual([
      { businessId: BUSINESS_ID, now: "2026-07-24T10:01:00.001Z", limit: 10 },
    ]);
  });

  it("claims a batch of due queued Runs with an owned, timed lease", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun({ status: "claimed" })];
    const manager = new RunLeaseManager(store);

    const claimed = await manager.claimBatch({
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: new Date("2026-07-24T10:00:00.000Z"),
      leaseDurationMs: 60_000,
      limit: 10,
    });

    expect(claimed).toEqual(store.claimBatchResult);
    expect(store.claimBatchCalls).toEqual([
      {
        businessId: BUSINESS_ID,
        owner: "worker-1",
        input: { now: "2026-07-24T10:00:00.000Z", leaseDurationMs: 60_000, limit: 10 },
      },
    ]);
  });
});
