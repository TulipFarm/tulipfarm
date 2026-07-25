import { describe, expect, it } from "vitest";
import {
  type AdmissionRequest,
  ConcurrencyError,
  type ConcurrencySlot,
  decideAdmission,
  type RunConcurrencyStore,
  TargetConcurrencyManager,
} from "./concurrency";

const BUSINESS_ID = "business-1";
const TARGET_KEY = "sha256:target";

function slot(runId: string, status: ConcurrencySlot["status"], sequence: number): ConcurrencySlot {
  return { runId, status, sequence };
}

function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    businessId: BUSINESS_ID,
    runId: "run-new",
    targetKey: TARGET_KEY,
    policy: "serialize",
    maxConcurrency: 1,
    maxQueued: 10,
    requestedAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("decideAdmission", () => {
  it("admits freely under `parallel`", () => {
    const decision = decideAdmission(request({ policy: "parallel", maxConcurrency: null }), [
      slot("run-a", "held", 1),
      slot("run-b", "held", 2),
    ]);

    expect(decision).toEqual({ kind: "hold" });
  });

  it("queues behind the single holder under `serialize`", () => {
    expect(decideAdmission(request(), [slot("run-a", "held", 1)])).toEqual({ kind: "queue" });
  });

  it("admits under `queue` while capacity remains and queues past it", () => {
    const queued = request({ policy: "queue", maxConcurrency: 2, maxQueued: 1 });

    expect(decideAdmission(queued, [slot("run-a", "held", 1)])).toEqual({ kind: "hold" });
    expect(decideAdmission(queued, [slot("run-a", "held", 1), slot("run-b", "held", 2)])).toEqual({
      kind: "queue",
    });
  });

  it("rejects a `queue` admission that would exceed the bounded queue", () => {
    const queued = request({ policy: "queue", maxConcurrency: 1, maxQueued: 1 });

    expect(decideAdmission(queued, [slot("run-a", "held", 1), slot("run-b", "queued", 2)])).toEqual(
      { kind: "reject", reason: "queue_full" }
    );
  });

  it("coalesces onto the earliest live slot instead of starting duplicate work", () => {
    expect(
      decideAdmission(request({ policy: "coalesce" }), [
        slot("run-a", "held", 1),
        slot("run-b", "queued", 2),
      ])
    ).toEqual({ kind: "coalesce", withRunId: "run-a" });
  });

  it("admits a `coalesce` request when the target key is idle", () => {
    expect(decideAdmission(request({ policy: "coalesce" }), [])).toEqual({ kind: "hold" });
  });

  it("rejects deterministically under `reject` when the key is busy", () => {
    expect(decideAdmission(request({ policy: "reject" }), [slot("run-a", "held", 1)])).toEqual({
      kind: "reject",
      reason: "target_busy",
    });
  });

  it("supersedes every live slot under `supersede`, newest request winning", () => {
    expect(
      decideAdmission(request({ policy: "supersede" }), [
        slot("run-a", "held", 1),
        slot("run-b", "queued", 2),
      ])
    ).toEqual({ kind: "supersede", supersedeRunIds: ["run-a", "run-b"] });
  });

  it("is idempotent for a slot this Run already holds so a retry never double-admits", () => {
    expect(decideAdmission(request({ runId: "run-a" }), [slot("run-a", "held", 1)])).toEqual({
      kind: "hold",
    });
  });
});

describe("TargetConcurrencyManager", () => {
  class FakeStore implements RunConcurrencyStore {
    admitCalls: unknown[] = [];
    releaseCalls: unknown[] = [];
    slots: ConcurrencySlot[] = [];

    async admit(
      input: {
        businessId: string;
        runId: string;
        targetKey: string;
        stateKey: string;
        policy: string;
        requestedAt: string;
      },
      decide: (slots: readonly ConcurrencySlot[]) => ReturnType<typeof decideAdmission>
    ) {
      this.admitCalls.push(input);
      const action = decide(this.slots);
      return { action, slots: this.slots };
    }

    async release(businessId: string, targetKey: string, runId: string, now: string) {
      this.releaseCalls.push({ businessId, targetKey, runId, now });
      return { released: true, promotedRunId: "run-next" };
    }

    async listSlots() {
      return this.slots;
    }
  }

  const base = {
    businessId: BUSINESS_ID,
    runId: "run-new",
    stateKey: "apply",
    targetKey: TARGET_KEY,
    requestedAt: "2026-07-25T10:00:00.000Z",
  };

  it("reports the store's decision with the target key that produced it", async () => {
    const store = new FakeStore();
    store.slots = [slot("run-a", "held", 1)];

    const decision = await new TargetConcurrencyManager(store).admit({
      ...base,
      policy: "serialize",
    });

    expect(decision).toEqual({
      outcome: "queued",
      targetKey: TARGET_KEY,
      runId: "run-new",
      holders: ["run-a"],
      supersededRunIds: [],
      queuePosition: 1,
    });
  });

  it("returns the promoted successor when a holder releases its slot", async () => {
    const store = new FakeStore();

    const released = await new TargetConcurrencyManager(store).release({
      businessId: BUSINESS_ID,
      targetKey: TARGET_KEY,
      runId: "run-a",
      now: "2026-07-25T10:05:00.000Z",
    });

    expect(released).toEqual({ released: true, promotedRunId: "run-next" });
  });

  it("rejects a policy whose bounds an Agent could use to widen concurrency", async () => {
    const manager = new TargetConcurrencyManager(new FakeStore());

    await expect(
      manager.admit({ ...base, policy: "serialize", maxConcurrency: 4 })
    ).rejects.toThrow(new ConcurrencyError("invalid_concurrency_policy", "maxConcurrency"));
    await expect(manager.admit({ ...base, policy: "reject", maxQueued: 5 })).rejects.toThrow(
      new ConcurrencyError("invalid_concurrency_policy", "maxQueued")
    );
    await expect(manager.admit({ ...base, policy: "queue", maxConcurrency: 0 })).rejects.toThrow(
      new ConcurrencyError("invalid_concurrency_policy", "maxConcurrency")
    );
  });
});
