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
    const { manager, current } = harness(run(), [{ runId: "run-1", stateId: "write", state }]);

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
    const { manager } = harness(run(), [{ runId: "run-1", stateId: "write", state: "confirmed" }]);

    await expect(
      manager.reconcile({
        businessId: "business-1",
        runId: "run-1",
        expectedVersion: 3,
      })
    ).resolves.toMatchObject({ outcome: "needs_reconciliation" });
  });

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
    const { manager } = harness(run(), [{ runId: "run-1", stateId: "write", state: "ambiguous" }]);

    await expect(manager.sweep({ businessId: "business-1", limit: 10 })).resolves.toEqual({
      examined: 1,
      requeued: 0,
      needsReconciliation: 1,
    });
  });
});
