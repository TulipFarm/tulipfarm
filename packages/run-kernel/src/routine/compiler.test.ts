import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  compileRoutine,
  type IdentityCeiling,
  ROUTINE_BOUND_CEILINGS,
  RoutineCompileError,
} from "./compiler";

const ceiling: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:read", "github:issues:write"],
  maxRiskClass: "medium",
};

function routine(
  states: routineSchema.RoutineState[],
  spec: Record<string, unknown> = {}
): routineSchema.RoutineDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "01J0000000000000000000ROUT",
      slug: "issue-triage",
      schemaVersion: 1,
      authoredVersion: 3,
      lifecycle: "published",
    },
    spec: {
      owner: "platform",
      start: states[0]?.name ?? "Start",
      states,
      ...spec,
    },
  } as routineSchema.RoutineDefinition;
}

const classify: routineSchema.RoutineState = {
  type: "agent",
  name: "Classify",
  agentRef: { name: "triage", version: "1.0.0" },
  output: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
  transition: "Decide",
};

const decide: routineSchema.RoutineState = {
  type: "branch",
  name: "Decide",
  conditions: [{ condition: 'states.Classify.output.label == "bug"', transition: "Label" }],
  default: { end: true },
};

const label: routineSchema.RoutineState = {
  type: "tool",
  name: "Label",
  toolRef: { name: "github", version: "2.0.0" },
  action: "issues.addLabels",
  input: { issue: `\${ input.issueId }`, label: "bug" },
  end: true,
};

describe("compileRoutine", () => {
  it("compiles an immutable typed graph with deterministic order and digest", () => {
    const compiled = compileRoutine(routine([classify, decide, label]), {
      identityCeiling: ceiling,
    });

    expect(compiled.order).toEqual(["Classify", "Decide", "Label"]);
    expect(compiled.states.get("Decide")?.successors).toEqual(["Label"]);
    expect(compiled.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(
      compileRoutine(routine([classify, decide, label]), { identityCeiling: ceiling }).digest
    ).toBe(compiled.digest);
  });

  it("compiles input mappings into expressions and literals", () => {
    const compiled = compileRoutine(routine([classify, decide, label]), {
      identityCeiling: ceiling,
    });
    const mappings = compiled.states.get("Label")?.inputs ?? [];

    expect(mappings.map((m) => m.name)).toEqual(["issue", "label"]);
    const issueNode = mappings[0]?.node;
    expect(issueNode?.kind === "expression" && issueNode.expression.source).toBe(" input.issueId ");
    const labelNode = mappings[1]?.node;
    expect(labelNode?.kind === "literal" && labelNode.value).toBe("bug");
  });

  it("registers one output schema reference per state that declares one", () => {
    const compiled = compileRoutine(routine([classify, decide, label]), {
      identityCeiling: ceiling,
    });

    expect(compiled.outputSchemas.map((s) => s.ref)).toEqual([
      `${compiled.digest}#/states/Classify/output`,
    ]);
  });

  it("rejects a start state that does not exist", () => {
    const definition = routine([classify, decide, label], { start: "Nope" });

    expect(() => compileRoutine(definition, { identityCeiling: ceiling })).toThrow(
      new RoutineCompileError("unknown_start_state", "/spec/start")
    );
  });

  it("rejects a duplicate state name", () => {
    expect(() =>
      compileRoutine(routine([classify, { ...classify, transition: "Decide" }, decide, label]), {
        identityCeiling: ceiling,
      })
    ).toThrow(new RoutineCompileError("duplicate_state_name", "/spec/states/1/name"));
  });

  it("rejects an unknown transition target", () => {
    expect(() =>
      compileRoutine(routine([{ ...classify, transition: "Ghost" }, decide, label]), {
        identityCeiling: ceiling,
      })
    ).toThrow(new RoutineCompileError("unknown_transition_target", "/spec/states/0/transition"));
  });

  it("rejects an unreachable state instead of silently dropping it", () => {
    const orphan: routineSchema.RoutineState = {
      type: "wait",
      name: "Orphan",
      waitFor: { kind: "timer", durationMs: 10 },
      end: true,
    };

    expect(() =>
      compileRoutine(routine([classify, decide, label, orphan]), { identityCeiling: ceiling })
    ).toThrow(new RoutineCompileError("unreachable_state", "/spec/states/3"));
  });

  it("rejects a state that can neither transition nor end", () => {
    const stuck: routineSchema.RoutineState = {
      ...classify,
      transition: undefined,
      end: undefined,
    };

    expect(() => compileRoutine(routine([stuck]), { identityCeiling: ceiling })).toThrow(
      new RoutineCompileError("dangling_state", "/spec/states/0")
    );
  });

  it("rejects a cycle that no bounded construct closes", () => {
    const a: routineSchema.RoutineState = { ...classify, name: "A", transition: "B" };
    const b: routineSchema.RoutineState = { ...classify, name: "B", transition: "A" };

    expect(() => compileRoutine(routine([a, b]), { identityCeiling: ceiling })).toThrow(
      new RoutineCompileError("unbounded_cycle", "/spec/states/0")
    );
  });

  it("accepts a cycle closed by a bounded repeat_until", () => {
    const loop: routineSchema.RoutineState = {
      type: "repeat_until",
      name: "Loop",
      condition: "states.Work.output.done",
      body: "Work",
      maxIterations: 5,
      maxDurationMs: 60_000,
      end: true,
    };
    const work: routineSchema.RoutineState = { ...classify, name: "Work", transition: "Loop" };

    expect(() => compileRoutine(routine([loop, work]), { identityCeiling: ceiling })).not.toThrow();
  });

  it("rejects an expression reading a State that cannot precede it", () => {
    const early: routineSchema.RoutineState = {
      type: "branch",
      name: "Early",
      conditions: [{ condition: "states.Later.output.ok", end: true }],
      default: { transition: "Later" },
    };
    const later: routineSchema.RoutineState = {
      type: "agent",
      name: "Later",
      agentRef: { name: "triage", version: "1.0.0" },
      end: true,
    };

    expect(() => compileRoutine(routine([early, later]), { identityCeiling: ceiling })).toThrow(
      new RoutineCompileError("unreachable_reference", "/spec/states/0/conditions/0/condition")
    );
  });

  it("rejects an unsafe expression through the owning compile error", () => {
    const bad: routineSchema.RoutineState = {
      type: "branch",
      name: "Bad",
      conditions: [{ condition: "process.env.TOKEN", end: true }],
      default: { end: true },
    };

    expect(() => compileRoutine(routine([bad]), { identityCeiling: ceiling })).toThrow(
      new RoutineCompileError("invalid_expression", "/spec/states/0/conditions/0/condition")
    );
  });

  it("denies a State identity that is not the Run's ceiling principal", () => {
    const escalated: routineSchema.RoutineState = {
      ...classify,
      identity: { principalKind: "user", principalId: "admin" },
    };

    expect(() =>
      compileRoutine(routine([escalated, decide, label]), { identityCeiling: ceiling })
    ).toThrow(new RoutineCompileError("identity_escalation", "/spec/states/0/identity"));
  });

  it("denies a permission ceiling that broadens the Run's grants or risk class", () => {
    const broadened: routineSchema.RoutineState = {
      ...classify,
      permissionCeiling: { grants: ["github:repo:delete"] },
    };
    const riskier: routineSchema.RoutineState = {
      ...classify,
      permissionCeiling: { maxRiskClass: "high" },
    };

    expect(() =>
      compileRoutine(routine([broadened, decide, label]), { identityCeiling: ceiling })
    ).toThrow(
      new RoutineCompileError("permission_amplification", "/spec/states/0/permissionCeiling/grants")
    );
    expect(() =>
      compileRoutine(routine([riskier, decide, label]), { identityCeiling: ceiling })
    ).toThrow(
      new RoutineCompileError("risk_escalation", "/spec/states/0/permissionCeiling/maxRiskClass")
    );
  });

  it("caps every authored bound at the compiled ceiling", () => {
    const huge: routineSchema.RoutineState = {
      type: "foreach",
      name: "Fan",
      items: "input.rows",
      body: "Label",
      maxItems: ROUTINE_BOUND_CEILINGS.maxItems + 1,
      maxConcurrency: 2,
      end: true,
    };

    expect(() => compileRoutine(routine([huge, label]), { identityCeiling: ceiling })).toThrow(
      new RoutineCompileError("bound_exceeds_ceiling", "/spec/states/0/maxItems")
    );
  });

  it("rejects a compensate State that does not name a real tool State", () => {
    const compensate: routineSchema.RoutineState = {
      type: "compensate",
      name: "Undo",
      targetRef: "github.issues.removeLabels",
      forState: "Classify",
      end: true,
    };

    expect(() =>
      compileRoutine(routine([{ ...classify, transition: "Undo" }, compensate]), {
        identityCeiling: ceiling,
      })
    ).toThrow(new RoutineCompileError("compensation_target_invalid", "/spec/states/1/forState"));
  });

  it("never leaks authored payload values in a compile error message", () => {
    const bad: routineSchema.RoutineState = {
      type: "branch",
      name: "Bad",
      conditions: [{ condition: 'input.token == "sk-live-abcdef"', end: true }],
      default: { transition: "Ghost" },
    };

    try {
      compileRoutine(routine([bad]), { identityCeiling: ceiling });
      throw new Error("expected denial");
    } catch (error) {
      expect((error as RoutineCompileError).message).toBe(
        "unknown_transition_target:/spec/states/0/default/transition"
      );
    }
  });

  it("maps authored limits to runtime keys and units at both Routine and State scope", () => {
    const bounded: routineSchema.RoutineState = {
      type: "agent",
      name: "Classify",
      agentRef: { name: "triage", version: "1.0.0" },
      end: true,
      limits: { wallClockMs: 60_000, retries: 2, costUsd: 5, tokens: 1_000 },
    };

    const compiled = compileRoutine(
      routine([bounded], { limits: { costUsd: 2.5, wallClockMs: 120_000 } }),
      { identityCeiling: ceiling }
    );

    expect(compiled.limits).toEqual({ costMicros: 2_500_000, wallTimeMs: 120_000 });
    expect(compiled.states.get("Classify")?.limits).toEqual({
      wallTimeMs: 60_000,
      retries: 2,
      costMicros: 5_000_000,
      tokens: 1_000,
    });
  });
});
