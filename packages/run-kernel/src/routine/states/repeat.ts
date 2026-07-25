import type { CompiledState } from "../compiler";
import { evaluateCondition } from "../expressions";
import { RoutineStepError, type StepOutcome, stateOutcome } from "./step";

/** The durable loop record: iterations already completed and when the loop first started. */
export interface RepeatProgress {
  readonly iterations: number;
  readonly startedAtMs: number;
}

export type RepeatDecision =
  | { readonly kind: "body"; readonly iteration: number; readonly target: string }
  | { readonly kind: "exit"; readonly outcome: StepOutcome };

export function initRepeatProgress(nowMs: number): RepeatProgress {
  return { iterations: 0, startedAtMs: nowMs };
}

/**
 * Decide whether a `repeat_until` State runs its body again or exits.
 *
 * The body runs at least once — the termination condition describes when to stop, not whether to
 * start. Both bounds are required and are checked before every dispatch: an exhausted loop is a
 * fail-closed denial, never a silent exit that would look like the condition was met. A condition
 * that already holds wins over an exhausted bound, so a loop that finished on its last allowed
 * iteration completes normally.
 */
export function stepRepeat(
  state: CompiledState,
  progress: RepeatProgress,
  scope: Readonly<Record<string, unknown>>,
  nowMs: number
): RepeatDecision {
  const maxIterations = state.bounds.maxIterations;
  if (maxIterations === null) throw new RoutineStepError("iterations_not_bounded", state.name);
  const maxDurationMs = state.bounds.maxDurationMs;
  if (maxDurationMs === null) throw new RoutineStepError("duration_not_bounded", state.name);

  if (state.iterator === null) throw new RoutineStepError("missing_iterator", state.name);
  if (progress.iterations > 0 && evaluateCondition(state.iterator, scope)) {
    return { kind: "exit", outcome: stateOutcome(state) };
  }

  if (progress.iterations >= maxIterations) {
    throw new RoutineStepError("iteration_cap_exceeded", state.name);
  }
  if (nowMs - progress.startedAtMs >= maxDurationMs) {
    throw new RoutineStepError("duration_cap_exceeded", state.name);
  }

  if (state.body === null) throw new RoutineStepError("missing_body", state.name);
  return { kind: "body", iteration: progress.iterations, target: state.body };
}
