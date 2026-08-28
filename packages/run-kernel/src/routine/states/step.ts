import type { CompiledState } from "../compiler";

/**
 * State processors are pure and side-effect-free; callers persist decisions before dispatch, and
 * fail-closed errors contain no evaluated payload values.
 */

export type RoutineStepErrorCode =
  | "arm_cannot_progress"
  | "branch_already_settled"
  | "branch_no_match"
  | "collection_changed"
  | "condition_not_evaluable"
  | "collection_not_array"
  | "concurrency_not_bounded"
  | "deadline_not_bounded"
  | "duration_cap_exceeded"
  | "duration_not_bounded"
  | "item_already_settled"
  | "item_cap_exceeded"
  | "items_not_bounded"
  | "iteration_cap_exceeded"
  | "iterations_not_bounded"
  | "missing_action_name"
  | "missing_agent_ref"
  | "missing_body"
  | "missing_routine_ref"
  | "missing_script_source"
  | "missing_target_ref"
  | "missing_tool_ref"
  | "output_schema_not_declared"
  | "principals_not_declared"
  | "missing_iterator"
  | "state_cannot_progress"
  | "unknown_branch"
  | "unknown_item"
  | "wait_kind_not_supported";

export class RoutineStepError extends Error {
  constructor(
    readonly code: RoutineStepErrorCode,
    /** The State name, or the branch name for a branch-scoped denial. Never a payload value. */
    readonly subject: string
  ) {
    super(`${code}:${subject}`);
    this.name = "RoutineStepError";
  }
}

export type StepOutcome =
  | { readonly kind: "transition"; readonly target: string }
  | { readonly kind: "end" };

export type WorkStatus = "pending" | "running" | "succeeded" | "failed";

export function isSettled(status: WorkStatus): boolean {
  return status === "succeeded" || status === "failed";
}

export type JoinDecision =
  | { readonly kind: "pending" }
  | {
      readonly kind: "satisfied";
      readonly outcome: StepOutcome;
      readonly cancel: readonly string[];
    }
  | { readonly kind: "failed"; readonly failures: readonly string[] };

export function stateOutcome(state: CompiledState): StepOutcome {
  if (state.transition !== null) return { kind: "transition", target: state.transition };
  if (state.end) return { kind: "end" };
  throw new RoutineStepError("state_cannot_progress", state.name);
}

export function nextDispatchSlots(
  state: CompiledState,
  statuses: readonly WorkStatus[]
): { readonly indices: readonly number[]; readonly settled: boolean } {
  const cap = state.bounds.maxConcurrency;
  if (cap === null) throw new RoutineStepError("concurrency_not_bounded", state.name);

  const running = statuses.filter((status) => status === "running").length;
  const free = Math.max(0, cap - running);
  const indices: number[] = [];
  for (const [index, status] of statuses.entries()) {
    if (indices.length >= free) break;
    if (status === "pending") indices.push(index);
  }
  return { indices, settled: statuses.every(isSettled) };
}

/** Fan-out joins fail as soon as outstanding units cannot reach `need`. */
export function resolveJoin(
  state: CompiledState,
  keys: readonly string[],
  statuses: readonly WorkStatus[],
  need: number
): JoinDecision {
  const succeeded = statuses.filter((status) => status === "succeeded").length;
  const unsettled = statuses.filter((status) => !isSettled(status)).length;

  if (succeeded >= need) {
    const cancel = keys.filter((_, index) => {
      const status = statuses[index];
      return status !== undefined && !isSettled(status);
    });
    return { kind: "satisfied", outcome: stateOutcome(state), cancel };
  }
  if (succeeded + unsettled < need) {
    return { kind: "failed", failures: keys.filter((_, i) => statuses[i] === "failed") };
  }
  return { kind: "pending" };
}
