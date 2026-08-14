/** `ambiguous` is first-class: an effect that might have landed is never guessed resolved. */
export type EffectOutcome = "applied" | "not_applied" | "ambiguous";

export interface ReconciliationEvidence {
  readonly outcome: EffectOutcome;
  /** Reference to the durable observation that established the outcome. Never a payload. */
  readonly evidenceRef: string;
  readonly observedAt: string;
}

export type ReconciliationResolution =
  | { readonly kind: "resolved"; readonly status: "succeeded" | "cancelled" }
  | {
      readonly kind: "unresolved";
      readonly status: "needs_reconciliation";
      readonly reason: "ambiguous_effect";
    };

export type ReconciliationErrorCode =
  | "missing_reconciliation_evidence"
  | "state_not_found"
  | "state_not_reconciling"
  | "reconciliation_conflict";

/** Reconciliation denial carrying the reason code and offending field only. */
export class ReconciliationError extends Error {
  readonly name = "ReconciliationError";

  constructor(
    readonly code: ReconciliationErrorCode,
    readonly detail = ""
  ) {
    super(`${code}${detail ? `:${detail}` : ""}`);
  }
}

export interface ReconcilableStateStore {
  findState(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<{ status: string; version: number } | null>;
  transitionState(
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
  ): Promise<boolean>;
}

export interface ReconcileStateInput {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly evidence: ReconciliationEvidence;
}

export type ReconcileStateResult = ReconciliationResolution & {
  readonly stateKey: string;
  readonly evidenceRef: string;
};

/** Applied effects become `succeeded`; only proven-not-applied becomes `cancelled`. */
export function resolveReconciliation(evidence: ReconciliationEvidence): ReconciliationResolution {
  if (evidence.evidenceRef.length === 0) {
    throw new ReconciliationError("missing_reconciliation_evidence", "evidenceRef");
  }
  switch (evidence.outcome) {
    case "applied":
      return { kind: "resolved", status: "succeeded" };
    case "not_applied":
      return { kind: "resolved", status: "cancelled" };
    case "ambiguous":
      return { kind: "unresolved", status: "needs_reconciliation", reason: "ambiguous_effect" };
  }
}

/** Reconciliation settlement requires a parked State and evidence; lost CAS races are reported. */
export class StateReconciler {
  constructor(private readonly store: ReconcilableStateStore) {}

  async reconcile(input: ReconcileStateInput): Promise<ReconcileStateResult> {
    const resolution = resolveReconciliation(input.evidence);
    const state = await this.store.findState(input.businessId, input.runId, input.stateKey);
    if (!state) throw new ReconciliationError("state_not_found", input.stateKey);
    if (state.status !== "needs_reconciliation") {
      throw new ReconciliationError("state_not_reconciling", state.status);
    }
    if (resolution.kind === "unresolved") {
      return { ...resolution, stateKey: input.stateKey, evidenceRef: input.evidence.evidenceRef };
    }

    const applied = await this.store.transitionState(
      input.businessId,
      input.runId,
      input.stateKey,
      {
        expectedVersion: state.version,
        expectedStatus: "needs_reconciliation",
        status: resolution.status,
        finishedAt: input.evidence.observedAt,
        errorEvidenceRef: input.evidence.evidenceRef,
      }
    );
    if (!applied) throw new ReconciliationError("reconciliation_conflict", input.stateKey);
    return { ...resolution, stateKey: input.stateKey, evidenceRef: input.evidence.evidenceRef };
  }
}
