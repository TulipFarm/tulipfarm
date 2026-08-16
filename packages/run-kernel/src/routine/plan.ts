import type { routine as routineSchema } from "@tulipfarm/schema";
import type { JsonObject } from "../outputs";
import {
  type CompiledRoutine,
  compileRoutine,
  type IdentityCeiling,
  RoutineCompileError,
  stateFields,
} from "./compiler";

/**
 * All Routine shapes reduce to one `CompiledRoutine`; generated plans are bounded,
 * permission-checked, and never mutate the published Routine.
 */

function definition(
  slug: string,
  authoredVersion: number,
  spec: Record<string, unknown>
): routineSchema.RoutineDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: `generated:${slug}`,
      slug,
      schemaVersion: 1,
      authoredVersion,
      lifecycle: "published",
    },
    spec,
  } as routineSchema.RoutineDefinition;
}

export interface SingleAgentRoutineInput {
  readonly slug: string;
  readonly authoredVersion: number;
  readonly owner: string;
  readonly agentRef: { readonly name: string; readonly version: string };
  readonly identityCeiling: IdentityCeiling;
  readonly outputSchema?: JsonObject;
  /** Authored spelling and units (`costUsd`, `wallClockMs`), not the runtime `LimitSet`. */
  readonly limits?: NonNullable<routineSchema.RoutineSpec["limits"]>;
  readonly maxRepairAttempts?: number;
}

export function compileSingleAgentRoutine(input: SingleAgentRoutineInput): CompiledRoutine {
  const state: routineSchema.RoutineState = {
    type: "agent",
    name: "Agent",
    agentRef: input.agentRef,
    end: true,
    ...(input.outputSchema === undefined ? {} : { output: input.outputSchema }),
    ...(input.maxRepairAttempts === undefined
      ? {}
      : { maxRepairAttempts: input.maxRepairAttempts }),
  };
  return compileRoutine(
    definition(input.slug, input.authoredVersion, {
      owner: input.owner,
      start: "Agent",
      states: [state],
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    }),
    { identityCeiling: input.identityCeiling }
  );
}

export interface ChildPlanBounds {
  readonly maxItems?: number;
  readonly maxConcurrency?: number;
  readonly maxIterations?: number;
  readonly maxDurationMs?: number;
}

export interface ChildPlanEnvelope {
  readonly slug: string;
  readonly authoredVersion: number;
  /** The Run's ceiling. A generated plan can never be compiled under a different principal. */
  readonly identityCeiling: IdentityCeiling;
  readonly allowedStateTypes: readonly routineSchema.RoutineStateType[];
  readonly allowedAgents: readonly string[];
  readonly allowedTools: readonly string[];
  readonly maxStates: number;
  readonly bounds: ChildPlanBounds;
}

function refName(state: routineSchema.RoutineState, key: string): string | null {
  const value = stateFields(state)[key];
  if (typeof value !== "object" || value === null) return null;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

/** Envelope omissions deny State types, Agents, Tools, size, and construct bounds. */
export function compileGeneratedChildPlan(
  envelope: ChildPlanEnvelope,
  states: readonly routineSchema.RoutineState[],
  start: string
): CompiledRoutine {
  if (states.length === 0 || states.length > envelope.maxStates) {
    throw new RoutineCompileError("plan_too_large", "/spec/states");
  }

  for (const [index, state] of states.entries()) {
    const path = `/spec/states/${index}`;
    if (!envelope.allowedStateTypes.includes(state.type)) {
      throw new RoutineCompileError("state_type_not_permitted", `${path}/type`);
    }
    const agent = refName(state, "agentRef");
    if (agent !== null && !envelope.allowedAgents.includes(agent)) {
      throw new RoutineCompileError("agent_not_permitted", `${path}/agentRef`);
    }
    const tool = refName(state, "toolRef");
    if (tool !== null && !envelope.allowedTools.includes(tool)) {
      throw new RoutineCompileError("tool_not_permitted", `${path}/toolRef`);
    }
    for (const [key, ceiling] of Object.entries(envelope.bounds)) {
      const value = stateFields(state)[key];
      if (typeof value === "number" && typeof ceiling === "number" && value > ceiling) {
        throw new RoutineCompileError("bound_exceeds_ceiling", `${path}/${key}`);
      }
    }
  }

  return compileRoutine(
    definition(envelope.slug, envelope.authoredVersion, {
      owner: `${envelope.identityCeiling.principalKind}:${envelope.identityCeiling.principalId}`,
      start,
      states: [...states],
    }),
    { identityCeiling: envelope.identityCeiling }
  );
}
