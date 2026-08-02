import { RunLeaseManager, type RunLeaseStore } from "@tulipfarm/run-kernel";
import type { PersistedRun, PersistedRunStatus } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { RunExecutorRegistry, UnregisteredRunSourceError } from "./executors";
import { RunDispatcher } from "./run-dispatcher";

const BUSINESS_ID = "business-1";

function persistedRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    businessId: BUSINESS_ID,
    source: "chat",
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
  releaseCalls: { status: PersistedRunStatus }[] = [];
  claimBatchResult: readonly PersistedRun[] = [];

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
    if (transition.leaseOwner === null) this.releaseCalls.push(transition);
    return true;
  }

  async heartbeat(): Promise<boolean> {
    return true;
  }

  async reclaimExpiredRuns(): Promise<readonly PersistedRun[]> {
    return [];
  }

  async claimNextQueued(): Promise<readonly PersistedRun[]> {
    return this.claimBatchResult;
  }

  async find(_businessId: string, runId: string): Promise<PersistedRun | null> {
    return persistedRun({ id: runId, status: "running", version: 2 });
  }
}

describe("RunExecutorRegistry", () => {
  it("routes a Run to the executor registered for its source", async () => {
    const registry = new RunExecutorRegistry();
    const seen: string[] = [];
    registry.register("chat", async (run) => {
      seen.push(run.id);
      return "succeeded";
    });

    await expect(registry.execute(persistedRun())).resolves.toBe("succeeded");
    expect(seen).toEqual([persistedRun().id]);
    expect(registry.size).toBe(1);
  });

  it("rejects a duplicate registration rather than silently replacing an executor", () => {
    const registry = new RunExecutorRegistry();
    registry.register("chat", async () => "succeeded");
    expect(() => registry.register("chat", async () => "failed")).toThrow(
      'duplicate executor registered for Run source "chat"'
    );
  });

  it("throws with the missing source named when nothing owns the Run", async () => {
    const registry = new RunExecutorRegistry();
    await expect(registry.execute(persistedRun())).rejects.toThrow(UnregisteredRunSourceError);
    await expect(registry.execute(persistedRun())).rejects.toThrow(
      'no executor registered for Run source "chat"'
    );
  });

  it("parks a Run in needs_reconciliation when no executor is registered", async () => {
    const store = new FakeRunStore();
    store.claimBatchResult = [persistedRun()];
    const registry = new RunExecutorRegistry();
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(store),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
      handler: (run) => registry.execute(run),
    });

    const result = await dispatcher.dispatchBatch();

    expect(result).toMatchObject({ claimed: 1, dispatched: 0, failed: 1 });
    expect(store.releaseCalls).toEqual([
      expect.objectContaining({ status: "needs_reconciliation" }),
    ]);
  });
});
