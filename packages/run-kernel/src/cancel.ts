import type { ChildLinkStore } from "./children";
import type { RunStatus, StateStatus } from "./model";
import { assertRunTransition, assertStateTransition } from "./model";

export interface CancellableState {
  readonly key: string;
  readonly status: StateStatus;
  readonly version: number;
}

export type StateCancellationAction =
  | { readonly kind: "cancel"; readonly stateKey: string; readonly from: StateStatus }
  | { readonly kind: "reconcile"; readonly stateKey: string; readonly from: StateStatus }
  | { readonly kind: "skip"; readonly stateKey: string; readonly from: StateStatus };

export interface CancellationPlan {
  readonly states: readonly StateCancellationAction[];
  readonly terminalRunStatus: "cancelled" | "needs_reconciliation";
}

export type CancellationErrorCode =
  | "run_not_found"
  | "run_not_cancellable"
  | "unreconcilable_effect"
  | "cancellation_conflict";

/** Cancellation denial carrying the reason code and offending detail only. */
export class CancellationError extends Error {
  readonly name = "CancellationError";

  constructor(
    readonly code: CancellationErrorCode,
    readonly detail = ""
  ) {
    super(`${code}${detail ? `:${detail}` : ""}`);
  }
}

export interface CancellableRunStore {
  find(businessId: string, runId: string): Promise<{ status: string; version: number } | null>;
  listStates(businessId: string, runId: string): Promise<readonly CancellableState[]>;
  transitionRun(
    businessId: string,
    runId: string,
    transition: {
      expectedVersion: number;
      expectedStatus: string;
      status: string;
      finishedAt?: string;
    }
  ): Promise<boolean>;
  transitionState(
    businessId: string,
    runId: string,
    stateKey: string,
    transition: {
      expectedVersion: number;
      expectedStatus: string;
      status: string;
      finishedAt?: string;
    }
  ): Promise<boolean>;
}

export interface CancelRunInput {
  readonly businessId: string;
  readonly runId: string;
  readonly reason: string;
  readonly inFlightEffects: Readonly<Record<string, readonly string[]>>;
  readonly now: string;
}

export interface CancellationResult {
  readonly runId: string;
  readonly outcome: "cancelled" | "needs_reconciliation";
  readonly cancelledStateKeys: readonly string[];
  readonly reconcilingStateKeys: readonly string[];
  readonly cascadedChildRunIds: readonly string[];
  readonly detachedChildRunIds: readonly string[];
}

const TERMINAL_STATE_STATUSES: readonly StateStatus[] = [
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
];

const EFFECT_BEARING_STATUSES: readonly StateStatus[] = [
  "running",
  "waiting",
  "needs_reconciliation",
];

/**
 * Cancellation parks unresolved effects in `needs_reconciliation`; impossible effects are rejected.
 */
export function planCancellation(
  states: readonly CancellableState[],
  inFlightEffectStateKeys: readonly string[]
): CancellationPlan {
  for (const key of inFlightEffectStateKeys) {
    const state = states.find((candidate) => candidate.key === key);
    if (!state || !EFFECT_BEARING_STATUSES.includes(state.status)) {
      throw new CancellationError("unreconcilable_effect", key);
    }
  }

  const actions = states.map((state): StateCancellationAction => {
    if (TERMINAL_STATE_STATUSES.includes(state.status)) {
      return { kind: "skip", stateKey: state.key, from: state.status };
    }
    if (state.status === "needs_reconciliation" || inFlightEffectStateKeys.includes(state.key)) {
      return { kind: "reconcile", stateKey: state.key, from: state.status };
    }
    return { kind: "cancel", stateKey: state.key, from: state.status };
  });

  return {
    states: actions,
    terminalRunStatus: actions.some((action) => action.kind === "reconcile")
      ? "needs_reconciliation"
      : "cancelled",
  };
}

const UNCANCELLABLE_RUN_STATUSES: readonly string[] = ["succeeded", "failed", "cancelled"];

/**
 * Cancels future work and attached children, parks in-flight effects, and leaves detached children.
 * A parent is not cleanly `cancelled` while any cascaded unresolved effect remains.
 */
export class RunCancellationManager {
  constructor(
    private readonly runs: CancellableRunStore,
    private readonly children: ChildLinkStore
  ) {}

  async cancel(input: CancelRunInput): Promise<CancellationResult> {
    const run = await this.runs.find(input.businessId, input.runId);
    if (!run) throw new CancellationError("run_not_found", input.runId);
    if (UNCANCELLABLE_RUN_STATUSES.includes(run.status)) {
      throw new CancellationError("run_not_cancellable", run.status);
    }

    const states = await this.runs.listStates(input.businessId, input.runId);
    const plan = planCancellation(states, input.inFlightEffects[input.runId] ?? []);

    let version = run.version;
    let status = run.status;
    // A Run already in `cancelling` is re-driven, which makes a retried cancellation idempotent.
    if (status !== "cancelling" && status !== "needs_reconciliation") {
      assertRunTransition(status as RunStatus, "cancelling");
      version = await this.applyRun(input, version, status, "cancelling");
      status = "cancelling";
    }

    const cancelled: string[] = [];
    const reconciling: string[] = [];
    for (const action of plan.states) {
      const state = states.find((candidate) => candidate.key === action.stateKey);
      if (!state) continue;
      if (action.kind === "skip") continue;
      if (action.kind === "reconcile") {
        reconciling.push(action.stateKey);
        if (state.status !== "needs_reconciliation") {
          await this.applyState(input, state, "needs_reconciliation");
        }
        continue;
      }
      const afterCancelling = await this.applyState(input, state, "cancelling");
      await this.applyState(
        input,
        { ...state, status: "cancelling", version: afterCancelling },
        "cancelled"
      );
      cancelled.push(action.stateKey);
    }

    const links = await this.children.listChildren(input.businessId, input.runId);
    const cascaded: string[] = [];
    const detached: string[] = [];
    let childNeedsReconciliation = false;
    for (const link of links) {
      if (link.detachedAt !== null) {
        detached.push(link.childRunId);
        continue;
      }
      const childResult = await this.cancel({ ...input, runId: link.childRunId });
      cascaded.push(link.childRunId);
      childNeedsReconciliation ||= childResult.outcome === "needs_reconciliation";
    }

    const outcome =
      plan.terminalRunStatus === "needs_reconciliation" || childNeedsReconciliation
        ? "needs_reconciliation"
        : "cancelled";
    if (status !== outcome) {
      assertRunTransition(status as RunStatus, outcome);
      await this.applyRun(input, version, status, outcome);
    }

    return {
      runId: input.runId,
      outcome,
      cancelledStateKeys: cancelled,
      reconcilingStateKeys: reconciling,
      cascadedChildRunIds: cascaded,
      detachedChildRunIds: detached,
    };
  }

  private async applyRun(
    input: CancelRunInput,
    expectedVersion: number,
    expectedStatus: string,
    status: RunStatus
  ): Promise<number> {
    const applied = await this.runs.transitionRun(input.businessId, input.runId, {
      expectedVersion,
      expectedStatus,
      status,
      ...(status === "cancelled" ? { finishedAt: input.now } : {}),
    });
    if (!applied) throw new CancellationError("cancellation_conflict", input.runId);
    return expectedVersion + 1;
  }

  private async applyState(
    input: CancelRunInput,
    state: CancellableState,
    status: StateStatus
  ): Promise<number> {
    assertStateTransition(state.status, status);
    const applied = await this.runs.transitionState(input.businessId, input.runId, state.key, {
      expectedVersion: state.version,
      expectedStatus: state.status,
      status,
      ...(status === "cancelled" ? { finishedAt: input.now } : {}),
    });
    if (!applied) throw new CancellationError("cancellation_conflict", state.key);
    return state.version + 1;
  }
}
