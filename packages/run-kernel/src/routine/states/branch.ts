import type { CompiledState } from "../compiler";
import { type CompiledExpression, ExpressionError, evaluateCondition } from "../expressions";
import { RoutineStepError, type StepOutcome } from "./step";

/** Arm evaluation errors fail closed; they are never treated as non-matches. */
function matches(
  condition: CompiledExpression,
  scope: Readonly<Record<string, unknown>>,
  state: string
): boolean {
  try {
    return evaluateCondition(condition, scope);
  } catch (error) {
    if (error instanceof ExpressionError) {
      throw new RoutineStepError("condition_not_evaluable", state);
    }
    throw error;
  }
}

export interface BranchDecision {
  /** Index of the arm that matched, or `null` when the authored default was taken. */
  readonly armIndex: number | null;
  readonly outcome: StepOutcome;
}

/** Authored arm order is deterministic; no match uses default or denies if none exists. */
export function decideBranch(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>
): BranchDecision {
  for (const [armIndex, arm] of state.conditions.entries()) {
    if (!matches(arm.condition, scope, state.name)) continue;
    if (arm.transition !== null) {
      return { armIndex, outcome: { kind: "transition", target: arm.transition } };
    }
    if (arm.end) return { armIndex, outcome: { kind: "end" } };
    throw new RoutineStepError("arm_cannot_progress", state.name);
  }

  if (state.defaultTransition !== null) {
    return { armIndex: null, outcome: { kind: "transition", target: state.defaultTransition } };
  }
  if (state.defaultEnd) return { armIndex: null, outcome: { kind: "end" } };
  throw new RoutineStepError("branch_no_match", state.name);
}
