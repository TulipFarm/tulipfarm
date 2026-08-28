import type { CompiledInputNode, CompiledState } from "./compiler";
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
  const resolve = (node: CompiledInputNode): unknown => {
    switch (node.kind) {
      case "literal":
        return node.value;
      case "object":
        return Object.fromEntries(node.entries.map(([key, child]) => [key, resolve(child)]));
      case "array":
        return node.items.map(resolve);
      default: {
        const resolved = node.expression.evaluate(scope);
        // `undefined` is not a value the Context can hold: it would serialize away and reach a
        // Tool as an absent argument, so an unevaluable reference is refused by State name.
        if (resolved === undefined) {
          throw new RoutineInputResolutionError("input_not_evaluable", state.name);
        }
        return resolved;
      }
    }
  };

  const input: Record<string, unknown> = {};
  for (const mapping of state.inputs) {
    try {
      input[mapping.name] = resolve(mapping.node);
    } catch (error) {
      if (error instanceof ExpressionError) {
        throw new RoutineInputResolutionError("input_not_evaluable", state.name);
      }
      throw error;
    }
  }
  return input;
}
