import type { PersistedRun } from "@tulipfarm/storage";
import {
  DISPATCH_HANDLER_ERROR_REF,
  DISPATCH_LEASE_EXPIRED_REF,
  DISPATCH_REQUEUED_ONCE_REF,
  DISPATCH_UNSPECIFIED_PARK_REF,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  type RecoveryEffectReader,
  RunRecoveryManager,
  type TargetedRunRecoveryStore,
} from "./recover";

function run(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    id: "run-1",
    businessId: "business-1",
    source: "routine",
    bundle: { digest: "digest", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "user", id: "user-1" },
      guardrailContextRef: "guardrail-1",
    },
    status: "needs_reconciliation",
    version: 3,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:00:01.000Z",
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: DISPATCH_HANDLER_ERROR_REF,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseGeneration: 1,
    ...overrides,
  };
}

function harness(
  initial: PersistedRun | null,
  effects: Awaited<ReturnType<RecoveryEffectReader["list"]>> = []
) {
  let current = initial;
  const store: TargetedRunRecoveryStore = {
    find: async () => current,
    listRecoveryCandidates: async () => (current === null ? [] : [current]),
    requeueParkedRun: async (_businessId, _runId, expectedVersion, expectedEvidenceRef) => {
      if (
        current?.status !== "needs_reconciliation" ||
        current.version !== expectedVersion ||
        current.errorEvidenceRef !== expectedEvidenceRef
      ) {
        return null;
      }
      current = run({
        ...current,
        status: "queued",
        version: current.version + 1,
        errorEvidenceRef: DISPATCH_REQUEUED_ONCE_REF,
      });
      return current;
    },
  };
  return {
    manager: new RunRecoveryManager(store, { list: async () => effects }),
    current: () => current,
  };
}

describe("RunRecoveryManager", () => {
  it.each([DISPATCH_HANDLER_ERROR_REF, DISPATCH_LEASE_EXPIRED_REF, DISPATCH_UNSPECIFIED_PARK_REF])(
    "requeues retryable abandoned work once for %s",
    async (errorEvidenceRef) => {
      const { manager } = harness(run({ errorEvidenceRef }), []);

      await expect(
        manager.reconcile({
          businessId: "business-1",
          runId: "run-1",
          expectedVersion: 3,
        })
      ).resolves.toMatchObject({ outcome: "requeued", run: { status: "queued", version: 4 } });
    }
  );

  it("treats the same command after restart as a duplicate without another write", async () => {
    const { manager } = harness(
      run({ status: "queued", version: 4, errorEvidenceRef: DISPATCH_REQUEUED_ONCE_REF })
    );

    await expect(
      manager.reconcile({
        businessId: "business-1",
        runId: "run-1",
        expectedVersion: 3,
      })
    ).resolves.toMatchObject({ outcome: "already_requeued" });
  });

  it.each([
    "dispatched",
    "ambiguous",
    "compensating",
    "reconciliation_required",
    "future_provider_state",
  ])("leaves an effect without proven replay safety %s in reconciliation", async (state) => {
    const { manager, current } = harness(run(), [
      { runId: "run-1", stateId: "write", state, outputStored: false },
    ]);

    await expect(
      manager.reconcile({
        businessId: "business-1",
        runId: "run-1",
        expectedVersion: 3,
      })
    ).resolves.toMatchObject({ outcome: "needs_reconciliation" });
    expect(current()?.status).toBe("needs_reconciliation");
  });

  it("keeps a confirmed effect parked until durable output replay is available", async () => {
    const { manager } = harness(run(), [
      { runId: "run-1", stateId: "write", state: "confirmed", outputStored: false },
    ]);

    await expect(
      manager.reconcile({
        businessId: "business-1",
        runId: "run-1",
        expectedVersion: 3,
      })
    ).resolves.toMatchObject({ outcome: "needs_reconciliation" });
  });

  it("requeues a confirmed effect whose immutable output can be replayed", async () => {
    const { manager } = harness(run(), [
      { runId: "run-1", stateId: "write", state: "confirmed", outputStored: true },
    ]);

    await expect(
      manager.reconcile({
        businessId: "business-1",
        runId: "run-1",
        expectedVersion: 3,
      })
    ).resolves.toMatchObject({ outcome: "requeued" });
  });

  it.each(["awaiting_child", "authorized", "dispatched"])(
    "requeues a %s child adoption only with its immutable replay descriptor",
    async (state) => {
      const safe = harness(run(), [
        {
          runId: "run-1",
          stateId: "write",
          state,
          outputStored: true,
          output: { kind: "child_park", childRunId: "child-1", waitId: "wait-1" },
        },
      ]).manager;
      await expect(
        safe.reconcile({
          businessId: "business-1",
          runId: "run-1",
          expectedVersion: 3,
        })
      ).resolves.toMatchObject({ outcome: "requeued" });

      const unsafe = harness(run(), [
        { runId: "run-1", stateId: "write", state, outputStored: true, output: { kind: "other" } },
      ]).manager;
      await expect(
        unsafe.reconcile({
          businessId: "business-1",
          runId: "run-1",
          expectedVersion: 3,
        })
      ).resolves.toMatchObject({ outcome: "needs_reconciliation" });
    }
  );

  it("reports stale and terminal commands explicitly", async () => {
    const stale = harness(run({ version: 4 })).manager;
    await expect(
      stale.reconcile({ businessId: "business-1", runId: "run-1", expectedVersion: 3 })
    ).resolves.toMatchObject({ outcome: "version_conflict" });

    const cancelled = harness(
      run({ status: "cancelled", version: 5, errorEvidenceRef: null })
    ).manager;
    await expect(
      cancelled.reconcile({ businessId: "business-1", runId: "run-1", expectedVersion: 5 })
    ).resolves.toMatchObject({ outcome: "terminal", status: "cancelled" });
  });

  it("sweeps only recovery candidates and preserves Runs needing provider evidence", async () => {
    const { manager } = harness(run(), [
      { runId: "run-1", stateId: "write", state: "ambiguous", outputStored: false },
    ]);

    await expect(manager.sweep({ businessId: "business-1", limit: 10 })).resolves.toEqual({
      examined: 1,
      requeued: 0,
      needsReconciliation: 1,
    });
  });

  it("reaches a safe Run after a full page of blocked candidates across a restart", async () => {
    const candidates = Array.from({ length: 26 }, (_, index) =>
      run({
        id: `run-${index + 1}`,
        createdAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 1_000).toISOString(),
      })
    );
    let cursor = 0;
    const store: TargetedRunRecoveryStore = {
      find: async (_businessId, runId) =>
        candidates.find((candidate) => candidate.id === runId) ?? null,
      listRecoveryCandidates: async (_businessId, limit) => {
        const page = candidates
          .filter((candidate) => candidate.status === "needs_reconciliation")
          .slice(cursor, cursor + limit);
        cursor = page.length < limit ? 0 : cursor + page.length;
        return page;
      },
      requeueParkedRun: async (_businessId, runId, expectedVersion, expectedEvidenceRef) => {
        const index = candidates.findIndex((candidate) => candidate.id === runId);
        const current = candidates[index];
        if (
          current === undefined ||
          current.version !== expectedVersion ||
          current.errorEvidenceRef !== expectedEvidenceRef
        ) {
          return null;
        }
        const requeued = run({
          ...current,
          status: "queued",
          version: current.version + 1,
          errorEvidenceRef: DISPATCH_REQUEUED_ONCE_REF,
        });
        candidates[index] = requeued;
        return requeued;
      },
    };
    const effects = {
      list: async () =>
        candidates.slice(0, 25).map((candidate) => ({
          runId: candidate.id,
          stateId: "write",
          state: "ambiguous",
          outputStored: false,
        })),
    };

    await expect(
      new RunRecoveryManager(store, effects).sweep({ businessId: "business-1", limit: 25 })
    ).resolves.toEqual({ examined: 25, requeued: 0, needsReconciliation: 25 });
    await expect(
      new RunRecoveryManager(store, effects).sweep({ businessId: "business-1", limit: 25 })
    ).resolves.toEqual({ examined: 1, requeued: 1, needsReconciliation: 0 });
    expect(candidates[25]?.status).toBe("queued");
  });
});
