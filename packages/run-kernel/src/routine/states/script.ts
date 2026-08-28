import type { CompiledState } from "../compiler";
import { resolveRoutineStateInput } from "../input";
import { RoutineStepError } from "./step";

/**
 * Plans a `script` State: authored TypeScript run in a sealed isolate.
 *
 * Planning stays side-effect free, like every other State planner — it only resolves the authored
 * expressions into concrete arguments. Executing the source is the Worker's job, because the
 * isolate lives in `@tulipfarm/sandbox` and the kernel must not depend on it.
 *
 * Unlike `compute`, the result is *not* recomputed on replay. The isolate is deterministic by
 * construction, but it is not free, and an author's function is opaque to us in a way an
 * expression is not — so the value is persisted and read back instead.
 */

export const DEFAULT_SCRIPT_ENTRY = "run";

export interface ScriptExecutionPlan {
  readonly source: string;
  readonly entry: string;
  readonly input: Record<string, unknown>;
}

function authored(state: CompiledState): Record<string, unknown> {
  return state.definition as unknown as Record<string, unknown>;
}

export function planScriptExecution(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>
): ScriptExecutionPlan {
  if (state.type !== "script") throw new RoutineStepError("state_cannot_progress", state.name);
  const source = authored(state).script;
  if (typeof source !== "string" || source.trim() === "") {
    throw new RoutineStepError("missing_script_source", state.name);
  }
  const entry = authored(state).entry;
  return {
    source,
    entry: typeof entry === "string" && entry !== "" ? entry : DEFAULT_SCRIPT_ENTRY,
    input: resolveRoutineStateInput(state, scope),
  };
}
