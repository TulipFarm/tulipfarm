import type { CompiledState } from "../compiler";
import {
  isSettled,
  type JoinDecision,
  nextDispatchSlots,
  RoutineStepError,
  resolveJoin,
  type WorkStatus,
} from "./step";

export interface ParallelEntry {
  readonly branch: string;
  readonly status: WorkStatus;
}

/** The durable fan-out record: one entry per authored branch, in authored order. */
export interface ParallelProgress {
  readonly entries: readonly ParallelEntry[];
}

export interface ParallelPlan {
  /** Branches to start now — never a branch already running or settled. */
  readonly dispatch: readonly string[];
  readonly settled: boolean;
}

export function initParallelProgress(state: CompiledState): ParallelProgress {
  return {
    entries: state.branches.map((branch) => ({ branch, status: "pending" as const })),
  };
}

/**
 * Decide which branches to start. Only `pending` branches are ever dispatched, so a Run that
 * crashed after dispatching a branch but before recording its result resumes without starting
 * that branch a second time; the in-flight branch is settled by reconciliation instead.
 */
export function planParallel(state: CompiledState, progress: ParallelProgress): ParallelPlan {
  const statuses = progress.entries.map((entry) => entry.status);
  const { indices, settled } = nextDispatchSlots(state, statuses);
  return {
    dispatch: indices.map((index) => progress.entries[index]?.branch ?? ""),
    settled,
  };
}

/**
 * Record a branch's status. Re-recording the same settled status is a no-op so an at-least-once
 * completion signal is safe to replay; moving a settled branch back to an unsettled status is a
 * denial, because a confirmed branch result is immutable.
 */
export function settleParallelBranch(
  progress: ParallelProgress,
  branch: string,
  status: WorkStatus
): ParallelProgress {
  const current = progress.entries.find((entry) => entry.branch === branch);
  if (current === undefined) throw new RoutineStepError("unknown_branch", branch);
  if (current.status === status) return progress;
  if (isSettled(current.status)) throw new RoutineStepError("branch_already_settled", branch);

  return {
    entries: progress.entries.map((entry) =>
      entry.branch === branch ? { branch, status } : entry
    ),
  };
}

/** Successes a join needs: every branch for `all`, one for `any`, a strict majority for `quorum`. */
function required(join: CompiledState["join"], total: number): number {
  if (join === "any") return 1;
  if (join === "quorum") return Math.floor(total / 2) + 1;
  return total;
}

/** Resolve the join. An unspecified join is `all` — the conservative reading of a fan-out. */
export function joinParallel(state: CompiledState, progress: ParallelProgress): JoinDecision {
  const keys = progress.entries.map((entry) => entry.branch);
  const statuses = progress.entries.map((entry) => entry.status);
  return resolveJoin(state, keys, statuses, required(state.join, keys.length));
}
