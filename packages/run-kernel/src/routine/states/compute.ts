import type { CompiledState } from "../compiler";
import { resolveRoutineStateInput } from "../input";
import { RoutineStepError } from "./step";

/**
 * The deterministic step: a `compute` State derives values from expressions and nothing else.
 *
 * It is the only State type that both produces a value and reaches no model, Tool, Secret or
 * external system, so a Routine can shape, rename and decide over its own data — whatever
 * Trigger started it — without an LLM in the loop. The expression language is already total and
 * side-effect free, which is what makes recomputing this on replay safe: the same scope must
 * yield the same output, so the value never has to be persisted to survive a crash.
 */
export function computeStateOutput(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  if (state.type !== "compute") throw new RoutineStepError("state_cannot_progress", state.name);
  return resolveRoutineStateInput(state, scope);
}
