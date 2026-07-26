import { MemoryWaitStore } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { RunLeaseManager } from "../lease";
import { StateReconciler } from "../reconcile-state";
import { RunResumeGateway } from "../resume";
import { DurableWaitManager } from "../waits";
import { SimulatedCrash, SimulatedRunStore } from "./simulator";

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const OWNER = "worker-1";
const OTHER_OWNER = "worker-2";
const T0 = new Date("2026-07-25T10:00:00.000Z");
const AFTER_LEASE = new Date("2026-07-25T10:05:00.000Z");

function leaseFixture() {
  const store = new SimulatedRunStore();
  store.seedRun({ status: "queued" });
  return { store, leases: new RunLeaseManager(store) };
}

describe("crash at the claim boundary", () => {
  it("keeps the Run claimable when the claim never committed", async () => {
    const { store, leases } = leaseFixture();
    store.crashBefore("transitionRun");

    await expect(
      leases.claim({
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        owner: OWNER,
        now: T0,
        leaseDurationMs: 60_000,
        expectedVersion: 0,
        expectedStatus: "queued",
        status: "claimed",
      })
    ).rejects.toBeInstanceOf(SimulatedCrash);

    const run = await store.find(BUSINESS_ID, RUN_ID);
    expect(run?.status).toBe("queued");
    expect(run?.version).toBe(0);
    expect(run?.leaseOwner).toBeNull();

    const retried = await leases.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: OWNER,
      now: T0,
      leaseDurationMs: 60_000,
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
    });
    expect(retried.claimed).toBe(true);
  });

  it("does not claim twice when the commit landed but the acknowledgement was lost", async () => {
    const { store, leases } = leaseFixture();
    store.crashAfter("transitionRun");

    await expect(
      leases.claim({
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        owner: OWNER,
        now: T0,
        leaseDurationMs: 60_000,
        expectedVersion: 0,
        expectedStatus: "queued",
        status: "claimed",
      })
    ).rejects.toBeInstanceOf(SimulatedCrash);

    // The write survived the crash, so the blind retry loses the CAS instead of re-claiming.
    const retried = await leases.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: OWNER,
      now: T0,
      leaseDurationMs: 60_000,
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
    });
    expect(retried.claimed).toBe(false);
    expect(store.transitions).toHaveLength(1);
    const run = await store.find(BUSINESS_ID, RUN_ID);
    expect(run).toMatchObject({ status: "claimed", version: 1, leaseOwner: OWNER });
  });
});

describe("crash while holding a lease", () => {
  it("recovers an accepted Run once its lease expires", async () => {
    const { leases } = leaseFixture();
    await leases.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: OWNER,
      now: T0,
      leaseDurationMs: 60_000,
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
    });
    await leases.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: OWNER,
      now: T0,
      leaseDurationMs: 60_000,
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "running",
    });

    // Worker dies mid-Run: no release, no heartbeat.
    const reclaimed = await leases.reclaimExpired({
      businessId: BUSINESS_ID,
      now: AFTER_LEASE,
      limit: 10,
    });

    expect(reclaimed.map((run) => run.id)).toEqual([RUN_ID]);
    expect(reclaimed[0]).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    const reclaimedRun = reclaimed[0];
    const second = await leases.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: OTHER_OWNER,
      now: AFTER_LEASE,
      leaseDurationMs: 60_000,
      expectedVersion: reclaimedRun.version,
      expectedStatus: "queued",
      status: "claimed",
    });
    expect(second.claimed).toBe(true);
  });

  it("refuses a resurrected worker's commit after its lease was reclaimed", async () => {
    const { store, leases } = leaseFixture();
    await leases.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: OWNER,
      now: T0,
      leaseDurationMs: 60_000,
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
    });
    const running = await leases.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: OWNER,
      now: T0,
      leaseDurationMs: 60_000,
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "running",
    });
    const staleVersion = running.run?.version ?? -1;

    await leases.reclaimExpired({ businessId: BUSINESS_ID, now: AFTER_LEASE, limit: 10 });

    const released = await leases.release({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      expectedVersion: staleVersion,
      expectedStatus: "running",
      status: "succeeded",
    });
    const heartbeat = await leases.heartbeat({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: OWNER,
      now: AFTER_LEASE,
      leaseDurationMs: 60_000,
      expectedVersion: staleVersion,
    });

    expect(released).toBe(false);
    expect(heartbeat).toBe(false);
    expect((await store.find(BUSINESS_ID, RUN_ID))?.status).toBe("queued");
  });

  it("commits a terminal outcome exactly once under duplicate release", async () => {
    const { store, leases } = leaseFixture();
    store.seedRun({ status: "running", version: 4, leaseOwner: OWNER });

    const first = await leases.release({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      expectedVersion: 4,
      expectedStatus: "running",
      status: "succeeded",
    });
    const replay = await leases.release({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      expectedVersion: 4,
      expectedStatus: "running",
      status: "failed",
    });

    expect(first).toBe(true);
    expect(replay).toBe(false);
    expect(await store.find(BUSINESS_ID, RUN_ID)).toMatchObject({
      status: "succeeded",
      version: 5,
    });
  });
});

describe("crash at the wait boundary", () => {
  const waitFixture = () => {
    const runs = new SimulatedRunStore();
    runs.seedRun({ status: "waiting", version: 3 });
    const waits = new MemoryWaitStore();
    return { runs, manager: new DurableWaitManager(waits, new RunResumeGateway(runs)) };
  };

  const register = (manager: DurableWaitManager, expectedSignals: number) =>
    manager.register({
      id: "wait-1",
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateKey: "approve",
      kind: "approval",
      aggregation: expectedSignals === 1 ? "first" : "all",
      schemaRef: "schema://approval/1",
      allowedPrincipals: ["user:alice", "user:bob"],
      expectedSignals,
      quorum: null,
      deadlineAt: "2026-07-25T12:00:00.000Z",
      createdAt: "2026-07-25T09:00:00.000Z",
    });

  const signal = (
    manager: DurableWaitManager,
    token: string,
    overrides: { id: string; principal: string; correlationKey: string; receivedAt: string }
  ) =>
    manager.signal({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      token,
      schemaRef: "schema://approval/1",
      signalDigest: `sha256:${overrides.correlationKey}`,
      ...overrides,
    });

  it("resumes a Run once when the same signal is delivered twice", async () => {
    const { runs, manager } = waitFixture();
    const { token } = await register(manager, 1);

    const first = await signal(manager, token, {
      id: "signal-1",
      principal: "user:alice",
      correlationKey: "approval-1",
      receivedAt: "2026-07-25T10:00:00.000Z",
    });
    const redelivered = await signal(manager, token, {
      id: "signal-1-retry",
      principal: "user:alice",
      correlationKey: "approval-1",
      receivedAt: "2026-07-25T10:00:05.000Z",
    });

    expect(first.outcome).toBe("resumed");
    expect(redelivered.outcome).toBe("duplicate");
    expect(runs.requeues).toBe(1);
    expect((await runs.find(BUSINESS_ID, RUN_ID))?.status).toBe("queued");
  });

  it("resolves an aggregated wait once regardless of signal arrival order", async () => {
    const { runs, manager } = waitFixture();
    const { token } = await register(manager, 2);

    const later = await signal(manager, token, {
      id: "signal-b",
      principal: "user:bob",
      correlationKey: "approval-b",
      receivedAt: "2026-07-25T10:02:00.000Z",
    });
    const earlier = await signal(manager, token, {
      id: "signal-a",
      principal: "user:alice",
      correlationKey: "approval-a",
      receivedAt: "2026-07-25T10:01:00.000Z",
    });

    expect(later.outcome).toBe("recorded");
    expect(earlier.outcome).toBe("resumed");
    expect(runs.requeues).toBe(1);
  });

  it("parks the wait for reconciliation when the Run already left `waiting`", async () => {
    const { runs, manager } = waitFixture();
    const { token } = await register(manager, 1);
    runs.seedRun({ status: "cancelling", version: 4 });

    const delivered = await signal(manager, token, {
      id: "signal-1",
      principal: "user:alice",
      correlationKey: "approval-1",
      receivedAt: "2026-07-25T10:00:00.000Z",
    });

    expect(delivered.outcome).toBe("resolved_without_resume");
    expect(runs.requeues).toBe(0);
  });
});

describe("crash mid-effect", () => {
  it("settles a parked State only on evidence, never by assumption", async () => {
    const store = new SimulatedRunStore();
    store.seedState("charge", { status: "needs_reconciliation", version: 2 });
    const reconciler = new StateReconciler(store);

    const ambiguous = await reconciler.reconcile({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateKey: "charge",
      evidence: {
        outcome: "ambiguous",
        evidenceRef: "evidence://probe-1",
        observedAt: "2026-07-25T10:10:00.000Z",
      },
    });
    expect(ambiguous).toMatchObject({ kind: "unresolved", status: "needs_reconciliation" });
    expect(store.stateOf("charge")).toMatchObject({ status: "needs_reconciliation", version: 2 });

    const settled = await reconciler.reconcile({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateKey: "charge",
      evidence: {
        outcome: "applied",
        evidenceRef: "evidence://probe-2",
        observedAt: "2026-07-25T10:11:00.000Z",
      },
    });
    expect(settled).toMatchObject({ kind: "resolved", status: "succeeded" });
    expect(store.stateOf("charge")).toMatchObject({ status: "succeeded", version: 3 });
  });
});
