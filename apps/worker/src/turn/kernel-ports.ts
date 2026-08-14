import type { StateStatus } from "@tulipfarm/run-kernel";
import type { RunStore } from "@tulipfarm/storage";
import type { StateTransitionPort } from "../agent-state";

/** RunStore State transitions use fresh versions, so CAS races fail instead of overwriting. */

/** A CAS transition that lost. Never handled here — it means two workers held the same State. */
export class StateTransitionConflictError extends Error {
  readonly name = "StateTransitionConflictError";

  constructor(
    readonly runId: string,
    readonly stateKey: string,
    readonly from: string,
    readonly to: string
  ) {
    super(
      `state "${stateKey}" of run ${runId} could not move ${from} -> ${to}: ` +
        `it is no longer at that version and status`
    );
  }
}

export class MissingStateError extends Error {
  readonly name = "MissingStateError";

  constructor(
    readonly runId: string,
    readonly stateKey: string
  ) {
    super(`run ${runId} has no state "${stateKey}"`);
  }
}

/** Record `reason` only for non-success; RunStore never clears error evidence. */
export class RunStoreStateTransitions implements StateTransitionPort {
  constructor(private readonly runs: Pick<RunStore, "findState" | "transitionState">) {}

  async transition(input: {
    businessId: string;
    runId: string;
    stateKey: string;
    from: StateStatus;
    to: StateStatus;
    reason?: string;
  }): Promise<void> {
    const state = await this.runs.findState(input.businessId, input.runId, input.stateKey);
    if (state === null) throw new MissingStateError(input.runId, input.stateKey);

    const moved = await this.runs.transitionState(input.businessId, input.runId, input.stateKey, {
      expectedVersion: state.version,
      expectedStatus: input.from,
      status: input.to,
      ...(input.to === "running" ? { startedAt: new Date().toISOString() } : {}),
      ...(TERMINAL_STATUSES.has(input.to) ? { finishedAt: new Date().toISOString() } : {}),
      ...(input.reason !== undefined && input.to !== "succeeded"
        ? { errorEvidenceRef: input.reason }
        : {}),
    });

    if (!moved) {
      throw new StateTransitionConflictError(input.runId, input.stateKey, input.from, input.to);
    }
  }
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "needs_reconciliation",
]);

/** Reclaim parked States through CAS `ready` then `claimed`; never steal a running State. */
export const RECLAIM_PATH: readonly StateStatus[] = ["ready", "claimed"];

async function walkReclaimPath(
  transitions: StateTransitionPort,
  request: { businessId: string; runId: string; stateKey: string },
  from: StateStatus
): Promise<void> {
  let current = from;
  for (const to of RECLAIM_PATH) {
    await transitions.transition({ ...request, from: current, to });
    current = to;
  }
}

export async function reclaimWaitingState(
  transitions: StateTransitionPort,
  request: { businessId: string; runId: string; stateKey: string }
): Promise<void> {
  await walkReclaimPath(transitions, request, "waiting");
}

/** First chat dispatch claims `pending` invoke State through `ready` and `claimed`. */
export async function reclaimPendingState(
  transitions: StateTransitionPort,
  request: { businessId: string; runId: string; stateKey: string }
): Promise<void> {
  await walkReclaimPath(transitions, request, "pending");
}
