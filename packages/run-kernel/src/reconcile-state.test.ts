import { describe, expect, it } from "vitest";
import {
  type ReconcilableStateStore,
  ReconciliationError,
  type ReconciliationEvidence,
  resolveReconciliation,
  StateReconciler,
} from "./reconcile-state";

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";

function evidence(overrides: Partial<ReconciliationEvidence> = {}): ReconciliationEvidence {
  return {
    outcome: "applied",
    evidenceRef: "evidence://effect/1",
    observedAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

class FakeStateStore implements ReconcilableStateStore {
  transitions: unknown[] = [];
  state: { status: string; version: number } | null = {
    status: "needs_reconciliation",
    version: 3,
  };

  async findState(_businessId: string, _runId: string, _stateKey: string) {
    return this.state;
  }

  async transitionState(
    businessId: string,
    runId: string,
    stateKey: string,
    transition: {
      expectedVersion: number;
      expectedStatus: string;
      status: string;
      finishedAt?: string;
      errorEvidenceRef?: string;
    }
  ) {
    this.transitions.push({ businessId, runId, stateKey, transition });
    return true;
  }
}

describe("resolveReconciliation", () => {
  it("honours an effect that provably landed", () => {
    expect(resolveReconciliation(evidence({ outcome: "applied" }))).toEqual({
      kind: "resolved",
      status: "succeeded",
    });
  });

  it("cancels only when the effect provably did not land", () => {
    expect(resolveReconciliation(evidence({ outcome: "not_applied" }))).toEqual({
      kind: "resolved",
      status: "cancelled",
    });
  });

  it("keeps an ambiguous effect unresolved instead of silently cancelling it", () => {
    expect(resolveReconciliation(evidence({ outcome: "ambiguous" }))).toEqual({
      kind: "unresolved",
      status: "needs_reconciliation",
      reason: "ambiguous_effect",
    });
  });

  it("requires evidence, so an outcome can never be asserted without a reference", () => {
    expect(() => resolveReconciliation(evidence({ evidenceRef: "" }))).toThrow(
      new ReconciliationError("missing_reconciliation_evidence", "evidenceRef")
    );
  });
});

describe("StateReconciler", () => {
  const reconcile = (store: ReconcilableStateStore, ev: ReconciliationEvidence) =>
    new StateReconciler(store).reconcile({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateKey: "charge",
      evidence: ev,
    });

  it("settles a reconciling State once the effect is proven applied", async () => {
    const store = new FakeStateStore();

    const result = await reconcile(store, evidence({ outcome: "applied" }));

    expect(result).toEqual({
      kind: "resolved",
      status: "succeeded",
      stateKey: "charge",
      evidenceRef: "evidence://effect/1",
    });
    expect(store.transitions).toEqual([
      {
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        stateKey: "charge",
        transition: {
          expectedVersion: 3,
          expectedStatus: "needs_reconciliation",
          status: "succeeded",
          finishedAt: "2026-07-25T10:00:00.000Z",
          errorEvidenceRef: "evidence://effect/1",
        },
      },
    ]);
  });

  it("leaves an ambiguous effect in `needs_reconciliation` and writes no transition", async () => {
    const store = new FakeStateStore();

    const result = await reconcile(store, evidence({ outcome: "ambiguous" }));

    expect(result).toMatchObject({ kind: "unresolved", status: "needs_reconciliation" });
    expect(store.transitions).toEqual([]);
  });

  it("refuses to reconcile a State that is not awaiting reconciliation", async () => {
    const store = new FakeStateStore();
    store.state = { status: "running", version: 2 };

    await expect(reconcile(store, evidence())).rejects.toThrow(
      new ReconciliationError("state_not_reconciling", "running")
    );
  });

  it("refuses to reconcile a State that no longer exists", async () => {
    const store = new FakeStateStore();
    store.state = null;

    await expect(reconcile(store, evidence())).rejects.toThrow(
      new ReconciliationError("state_not_found", "charge")
    );
  });

  it("reports a lost optimistic-concurrency race instead of claiming success", async () => {
    const store = new FakeStateStore();
    store.transitionState = async () => false;

    await expect(reconcile(store, evidence())).rejects.toThrow(
      new ReconciliationError("reconciliation_conflict", "charge")
    );
  });
});
