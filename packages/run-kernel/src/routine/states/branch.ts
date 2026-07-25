import type { CompiledState } from "../compiler";
import { type CompiledExpression, ExpressionError, evaluateCondition } from "../expressions";
import { RoutineStepError, type StepOutcome } from "./step";

/**
 * Evaluate one arm. An expression that cannot be evaluated against this Context — comparing a
 * missing value, say — is a fail-closed State failure, not a silent non-match that would quietly
 * route the Run down its default path.
 */
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

/**
 * Pick a `branch` State's successor. Arms are evaluated in authored order and the first match
 * wins, so the same Context always yields the same successor — a replayed or reconciled Run
 * cannot silently take a different path. A Context that no arm matches falls through to the
 * authored default; a graph with no match and no default is a denial.
 */
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
