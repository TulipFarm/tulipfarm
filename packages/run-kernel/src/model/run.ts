export const RUN_STATUSES = [
  "queued",
  "claimed",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
  "attention_required",
  "needs_reconciliation",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const STATE_STATUSES = [
  "pending",
  "ready",
  "claimed",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "cancelling",
  "cancelled",
  "needs_reconciliation",
] as const;

export type StateStatus = (typeof STATE_STATUSES)[number];

export type RunTransitionErrorCode = "invalid_run_transition" | "invalid_state_transition";

export class RunTransitionError extends Error {
  readonly name = "RunTransitionError";

  constructor(
    readonly code: RunTransitionErrorCode,
    readonly from: RunStatus | StateStatus,
    readonly to: RunStatus | StateStatus
  ) {
    super(`${code}:${from}->${to}`);
  }
}

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["claimed", "cancelling", "attention_required"],
  claimed: ["queued", "running", "cancelling", "attention_required"],
  running: [
    "waiting",
    "succeeded",
    "failed",
    "cancelling",
    "attention_required",
    "needs_reconciliation",
  ],
  waiting: ["queued", "cancelling", "attention_required"],
  succeeded: [],
  failed: [],
  cancelling: ["cancelled", "needs_reconciliation"],
  cancelled: [],
  attention_required: ["queued", "failed", "cancelling"],
  needs_reconciliation: ["queued", "failed", "cancelled", "succeeded"],
};

const STATE_TRANSITIONS: Readonly<Record<StateStatus, readonly StateStatus[]>> = {
  pending: ["ready", "skipped", "cancelling", "cancelled"],
  ready: ["claimed", "skipped", "cancelling", "cancelled"],
  claimed: ["ready", "running", "cancelling"],
  running: ["waiting", "succeeded", "failed", "cancelling", "needs_reconciliation"],
  waiting: ["ready", "cancelling", "needs_reconciliation"],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelling: ["cancelled", "needs_reconciliation"],
  cancelled: [],
  needs_reconciliation: ["ready", "failed", "cancelled", "succeeded"],
};

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!RUN_TRANSITIONS[from].includes(to)) {
    throw new RunTransitionError("invalid_run_transition", from, to);
  }
}

export function assertStateTransition(from: StateStatus, to: StateStatus): void {
  if (!STATE_TRANSITIONS[from].includes(to)) {
    throw new RunTransitionError("invalid_state_transition", from, to);
  }
}
