import type { routine as routineSchema } from "@tulipfarm/schema";
import type { LimitSet } from "../limits";
import type { JsonObject } from "../outputs";
import {
  type CompiledRoutine,
  compileRoutine,
  type IdentityCeiling,
  RoutineCompileError,
  stateFields,
} from "./compiler";

/**
 * The three Routine shapes SPEC §9.1 allows — a simple one-Agent automation, an explicit
 * authored graph, and a Run-local plan an Agent proposes inside a published envelope — all
 * reduce to one {@link CompiledRoutine}. State processors therefore never branch on "which kind
 * of Routine is this": a generated plan is bounded, permission-checked, and compiled by exactly
 * the same rules as a published graph, and it never mutates the published Routine it runs under.
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
  readonly limits?: LimitSet;
  readonly maxRepairAttempts?: number;
}

/** Compile the degenerate one-Agent Routine: a single bounded Agent State that ends the Run. */
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

/**
 * Compile a bounded Agent-proposed child plan. Everything the envelope did not explicitly permit
 * is denied — State types, Agents, Tools, plan size, and per-construct bounds — before the plan
 * reaches the shared compiler, so a generated plan cannot widen the Run it was proposed inside.
 */
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
