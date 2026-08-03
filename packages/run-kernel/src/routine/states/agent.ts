import type { JsonObject } from "../../outputs";
import type { CompiledState } from "../compiler";
import { resolveRoutineStateInput } from "../input";
import { RoutineStepError } from "./step";

/**
 * Planning for an `agent` State. Like `tool`, this decides *what* would be asked and never asks it:
 * the Agent runtime owns the model call and the bounded Tool loop, and this file owns only the
 * deterministic part — which Agent, at which authored version, over which resolved input, against
 * which declared output schema.
 *
 * Keeping it here is what makes a replay reach the same question. The input is resolved from the
 * Context by the same rules every other State uses, so a resumed Run asks the Agent what the first
 * attempt asked it rather than what the Context happens to hold now.
 */

export interface AgentStateRef {
  readonly name: string;
  readonly version: string;
}

export interface AgentInvocationPlan {
  readonly agentRef: AgentStateRef;
  /** The State's authored input, resolved against the Context — the Agent's actual question. */
  readonly input: Record<string, unknown>;
  /** Reference the answer is validated against when the State declares one. */
  readonly outputSchemaRef: string | null;
  /** How many malformed answers the loop may ask the Agent to repair; authored, never invented. */
  readonly maxRepairAttempts?: number;
}

function authored(state: CompiledState): Record<string, unknown> {
  return state.definition as unknown as Record<string, unknown>;
}

/**
 * The authored Agent reference. Required by the Routine schema; reading it defensively means a
 * State that reached here without one is refused by name rather than run against an Agent this
 * code chose.
 */
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

/** The output schema the State declared, as the compiled Routine registered it. */
export function agentOutputSchema(
  outputSchemas: readonly { readonly ref: string; readonly schema: JsonObject }[],
  outputSchemaRef: string | null
): JsonObject | undefined {
  if (outputSchemaRef === null) return undefined;
  return outputSchemas.find((registration) => registration.ref === outputSchemaRef)?.schema;
}
