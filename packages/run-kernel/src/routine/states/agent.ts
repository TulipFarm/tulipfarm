import type { JsonObject } from "../../outputs";
import type { CompiledState } from "../compiler";
import { resolveRoutineStateInput } from "../input";
import { RoutineStepError } from "./step";

/**
 * Agent planning is deterministic and side-effect-free: Agent version, resolved input, and output
 * schema are fixed so replay asks the same question.
 */

export interface AgentStateRef {
  readonly name: string;
  readonly version: string;
}

export interface AgentInvocationPlan {
  readonly agentRef: AgentStateRef;
  readonly input: Record<string, unknown>;
  readonly outputSchemaRef: string | null;
  /** How many malformed answers the loop may ask the Agent to repair; authored, never invented. */
  readonly maxRepairAttempts?: number;
}

function authored(state: CompiledState): Record<string, unknown> {
  return state.definition as unknown as Record<string, unknown>;
}

/** Missing authored Agent reference is refused by State name, never invented. */
function agentRefOf(state: CompiledState): AgentStateRef {
  const value = authored(state).agentRef;
  if (typeof value !== "object" || value === null) {
    throw new RoutineStepError("missing_agent_ref", state.name);
  }
  const { name, version } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new RoutineStepError("missing_agent_ref", state.name);
  }
  return { name, version };
}

/** Plan the invocation an `agent` State describes, with its input resolved from the Context. */
export function planAgentInvocation(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>
): AgentInvocationPlan {
  if (state.type !== "agent") throw new RoutineStepError("state_cannot_progress", state.name);
  const maxRepairAttempts = authored(state).maxRepairAttempts;

  return {
    agentRef: agentRefOf(state),
    input: resolveRoutineStateInput(state, scope),
    outputSchemaRef: state.outputSchemaRef,
    ...(typeof maxRepairAttempts === "number" ? { maxRepairAttempts } : {}),
  };
}

export function agentOutputSchema(
  outputSchemas: readonly { readonly ref: string; readonly schema: JsonObject }[],
  outputSchemaRef: string | null
): JsonObject | undefined {
  if (outputSchemaRef === null) return undefined;
  return outputSchemas.find((registration) => registration.ref === outputSchemaRef)?.schema;
}
