import type { CompiledState } from "./compiler";
import { ExpressionError } from "./expressions";

export type RoutineInputResolutionErrorCode = "input_not_evaluable";

/** Payload-safe refusal to resolve one State's authored input mapping. */
export class RoutineInputResolutionError extends Error {
  readonly name = "RoutineInputResolutionError";

  constructor(
    readonly code: RoutineInputResolutionErrorCode,
    readonly state: string
  ) {
    super(`${code}:${state}`);
  }
}

/** Resolve a compiled State's input mappings against the Context built so far. */
export function resolveRoutineStateInput(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const mapping of state.inputs) {
    if (mapping.expression === null) {
      input[mapping.name] = mapping.literal;
      continue;
    }
    try {
      const resolved = mapping.expression.evaluate(scope);
      if (resolved === undefined) {
        throw new RoutineInputResolutionError("input_not_evaluable", state.name);
      }
      input[mapping.name] = resolved;
    } catch (error) {
      if (error instanceof ExpressionError) {
        throw new RoutineInputResolutionError("input_not_evaluable", state.name);
      }
      throw error;
    }
  }
  return input;
}
