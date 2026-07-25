import type { routine as routineSchema } from "@tulipfarm/schema";
import {
  type CompiledRoutine,
  type CompiledState,
  compileRoutine,
  type IdentityCeiling,
} from "../compiler";

/** Shared fixtures for the State-processor tests. Not part of the package's public surface. */

export const TEST_CEILING: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:write"],
  maxRiskClass: "low",
};

export function endAgent(name: string): routineSchema.RoutineState {
  return { type: "agent", name, agentRef: { name: "triage", version: "1.0.0" }, end: true };
}

export function compileStates(
  states: readonly routineSchema.RoutineState[],
  start: string
): CompiledRoutine {
  return compileRoutine(
    {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "01J0000000000000000000ROUT",
        slug: "state-fixture",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: { owner: "platform", start, states: [...states] },
    } as routineSchema.RoutineDefinition,
    { identityCeiling: TEST_CEILING }
  );
}

/** Compile `states` and return the one named `start`. */
export function compileState(
  states: readonly routineSchema.RoutineState[],
  start: string
): CompiledState {
  const state = compileStates(states, start).states.get(start);
  if (state === undefined) throw new Error(`missing ${start}`);
  return state;
}

function targetsOf(state: routineSchema.RoutineState): string[] {
  const targets: string[] = [];
  if (typeof state.transition === "string") targets.push(state.transition);
  const handlers = Array.isArray(state.onError) ? state.onError : [];
  for (const handler of handlers) {
    if (typeof handler === "object" && handler !== null) {
      const { transition } = handler as Record<string, unknown>;
      if (typeof transition === "string") targets.push(transition);
    }
  }
  return targets;
}

/**
 * Compile `state` (optionally preceded by `before`) with an ending Agent stubbed in for every
 * transition target it names, so a fixture never trips the compiler's unreachable-State check.
 */
export function compileWithTargets(
  state: routineSchema.RoutineState,
  before: readonly routineSchema.RoutineState[] = []
): CompiledState {
  const declared = new Set([state.name, ...before.map((s) => s.name)]);
  const targets = new Set<string>();
  for (const source of [...before, state]) {
    for (const target of targetsOf(source)) if (!declared.has(target)) targets.add(target);
  }
  const states = [...before, state, ...[...targets].map(endAgent)];
  const compiled = compileStates(states, before[0]?.name ?? state.name).states.get(state.name);
  if (compiled === undefined) throw new Error(`missing ${state.name}`);
  return compiled;
}
