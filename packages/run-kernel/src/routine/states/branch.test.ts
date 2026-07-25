import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { type CompiledState, compileRoutine, type IdentityCeiling } from "../compiler";
import { decideBranch } from "./branch";
import { RoutineStepError } from "./step";

const identityCeiling: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:write"],
  maxRiskClass: "low",
};

function agent(name: string): routineSchema.RoutineState {
  return { type: "agent", name, agentRef: { name: "triage", version: "1.0.0" }, end: true };
}

/** Compile a `branch` State together with exactly the targets its arms name. */
function branch(
  conditions: Array<{ condition: string; transition?: string; end?: boolean }>,
  fallback: { transition?: string; end?: boolean }
): CompiledState {
  const targets = new Set<string>();
  for (const arm of conditions) if (arm.transition !== undefined) targets.add(arm.transition);
  if (fallback.transition !== undefined) targets.add(fallback.transition);

  const decide: routineSchema.RoutineState = {
    type: "branch",
    name: "Decide",
    conditions,
    default: fallback,
  };
  const compiled = compileRoutine(
    {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "01J0000000000000000000ROUT",
        slug: "branching",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: {
        owner: "platform",
        start: "Decide",
        states: [decide, ...[...targets].map(agent)],
      },
    } as routineSchema.RoutineDefinition,
    { identityCeiling }
  );
  const state = compiled.states.get("Decide");
  if (state === undefined) throw new Error("missing Decide");
  return state;
}

describe("decideBranch", () => {
  it("takes the first matching arm in authored order, deterministically", () => {
    const state = branch(
      [
        { condition: "input.score > 10", transition: "First" },
        { condition: "input.score > 1", transition: "Second" },
      ],
      { end: true }
    );
    const scope = { input: { score: 50 } };

    expect(decideBranch(state, scope)).toEqual({
      armIndex: 0,
      outcome: { kind: "transition", target: "First" },
    });
    expect(decideBranch(state, scope)).toEqual(decideBranch(state, scope));
  });

  it("falls through to the declared default when no arm matches", () => {
    const toDefault = branch([{ condition: "input.score > 10", transition: "First" }], {
      transition: "Second",
    });
    const toEnd = branch([{ condition: "input.score > 10", transition: "First" }], { end: true });

    expect(decideBranch(toDefault, { input: { score: 0 } })).toEqual({
      armIndex: null,
      outcome: { kind: "transition", target: "Second" },
    });
    expect(decideBranch(toEnd, { input: { score: 0 } })).toEqual({
      armIndex: null,
      outcome: { kind: "end" },
    });
  });

  it("fails closed when a condition cannot be evaluated against this Context", () => {
    const state = branch([{ condition: "input.score > 10", transition: "First" }], { end: true });

    expect(() => decideBranch(state, { input: {} })).toThrow(
      new RoutineStepError("condition_not_evaluable", "Decide")
    );
  });

  it("fails closed when nothing matches and the graph carries no default", () => {
    const compiled = branch([{ condition: "input.score > 10", transition: "First" }], {
      end: true,
    });
    const withoutDefault: CompiledState = {
      ...compiled,
      defaultTransition: null,
      defaultEnd: false,
    };

    expect(() => decideBranch(withoutDefault, { input: { score: 0 } })).toThrow(
      new RoutineStepError("branch_no_match", "Decide")
    );
  });

  it("never leaks evaluated payload values in a step error message", () => {
    const compiled = branch(
      [{ condition: 'input.token == "sk-live-abcdef"', transition: "First" }],
      {
        end: true,
      }
    );
    const withoutDefault: CompiledState = {
      ...compiled,
      defaultTransition: null,
      defaultEnd: false,
    };

    try {
      decideBranch(withoutDefault, { input: { token: "sk-live-zzz" } });
      throw new Error("expected denial");
    } catch (error) {
      expect((error as RoutineStepError).message).toBe("branch_no_match:Decide");
    }
  });
});
