import type { StateStatus } from "@tulipfarm/run-kernel";
import type { RunStore } from "@tulipfarm/storage";
import type { StateTransitionPort } from "../agent-state";

/**
 * The turn's ports onto the Run kernel tables.
 *
 * `AgentStateRunner` states transitions in kernel terms — "move this State from `running` to
 * `succeeded`" — while `RunStore` will only move a State it can prove nobody else moved first.
 * This file is that translation, and it is where the proof is obtained: the expected version is
 * read immediately before the write, so a lost race fails loudly instead of overwriting whatever
 * the other worker just recorded.
 */

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

/**
 * `StateTransitionPort` over `RunStore`.
 *
 * `reason` is recorded as the State's error evidence only when the State is ending badly. On a
 * `succeeded` transition there is nothing to explain, and `RunStore` never clears the column, so
 * writing one would leave a healthy State permanently carrying an error nobody can retract.
 */
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

/**
 * Re-claims a State its Run parked on, so the turn can run again.
 *
 * A Run resumed from a durable wait comes back with its `invoke` State still `waiting`, and the
 * kernel does not allow `waiting -> running` — a parked State has to be offered and claimed again,
 * exactly as it was the first time. Walking it back through `ready` and `claimed` is that claim,
 * and each hop is compare-and-swapped: if another worker got there first, the transition raises
 * rather than stealing a State somebody else is already running.
 */
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

/**
 * Claims a Run's `invoke` State on its first dispatch.
 *
 * The gateway persists a fresh State at `pending` (the same default a Routine's start State gets,
 * since one INSERT serves both), but nothing leases a State the way `RunLeaseManager` leases a Run
 * — a chat turn has exactly one State and dispatches it immediately, so this walks it through
 * `ready` and `claimed` itself rather than expecting it to arrive already claimed.
 */
export async function reclaimPendingState(
  transitions: StateTransitionPort,
  request: { businessId: string; runId: string; stateKey: string }
): Promise<void> {
  await walkReclaimPath(transitions, request, "pending");
}
