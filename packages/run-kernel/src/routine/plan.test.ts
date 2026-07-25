import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { type IdentityCeiling, RoutineCompileError } from "./compiler";
import {
  type ChildPlanEnvelope,
  compileGeneratedChildPlan,
  compileSingleAgentRoutine,
} from "./plan";

const identityCeiling: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:read"],
  maxRiskClass: "low",
};

const envelope: ChildPlanEnvelope = {
  slug: "triage-child-plan",
  authoredVersion: 1,
  identityCeiling,
  allowedStateTypes: ["agent", "tool", "branch"],
  allowedAgents: ["triage"],
  allowedTools: ["github"],
  maxStates: 4,
  bounds: { maxItems: 10, maxConcurrency: 2, maxIterations: 3, maxDurationMs: 1_000 },
};

describe("compileSingleAgentRoutine", () => {
  it("produces the same compiled contract as an authored graph", () => {
    const compiled = compileSingleAgentRoutine({
      slug: "ask-agent",
      authoredVersion: 1,
      owner: "platform",
      agentRef: { name: "triage", version: "1.0.0" },
      identityCeiling,
      outputSchema: { type: "object", properties: { answer: { type: "string" } } },
    });

    expect(compiled.order).toEqual(["Agent"]);
    expect(compiled.start).toBe("Agent");
    expect(compiled.states.get("Agent")?.end).toBe(true);
    expect(compiled.outputSchemas).toHaveLength(1);
    expect(compiled.identityCeiling.principalId).toBe("triage-bot");
  });
});

describe("compileGeneratedChildPlan", () => {
  const askAgent: routineSchema.RoutineState = {
    type: "agent",
    name: "Draft",
    agentRef: { name: "triage", version: "1.0.0" },
    transition: "Post",
  };
  const postTool: routineSchema.RoutineState = {
    type: "tool",
    name: "Post",
    toolRef: { name: "github", version: "2.0.0" },
    action: "issues.comment",
    end: true,
  };

  it("compiles a bounded generated plan into the same contract, under the envelope ceiling", () => {
    const compiled = compileGeneratedChildPlan(envelope, [askAgent, postTool], "Draft");

    expect(compiled.order).toEqual(["Draft", "Post"]);
    expect(compiled.identityCeiling).toEqual(identityCeiling);
    expect(compiled.states.get("Post")?.type).toBe("tool");
  });

  it("denies a State type the envelope never permitted", () => {
    const child: routineSchema.RoutineState = {
      type: "child_routine",
      name: "Spawn",
      routineRef: { name: "other", version: "1.0.0" },
      mode: "wait",
      end: true,
    };

    expect(() => compileGeneratedChildPlan(envelope, [child], "Spawn")).toThrow(
      new RoutineCompileError("state_type_not_permitted", "/spec/states/0/type")
    );
  });

  it("denies a Tool or Agent the envelope never exposed", () => {
    const sneaky: routineSchema.RoutineState = {
      ...postTool,
      toolRef: { name: "shell", version: "1.0.0" },
    };
    const otherAgent: routineSchema.RoutineState = {
      ...askAgent,
      agentRef: { name: "admin", version: "1.0.0" },
      transition: undefined,
      end: true,
    };

    expect(() => compileGeneratedChildPlan(envelope, [sneaky], "Post")).toThrow(
      new RoutineCompileError("tool_not_permitted", "/spec/states/0/toolRef")
    );
    expect(() => compileGeneratedChildPlan(envelope, [otherAgent], "Draft")).toThrow(
      new RoutineCompileError("agent_not_permitted", "/spec/states/0/agentRef")
    );
  });

  it("denies a plan larger than the envelope allows", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...postTool, name: `Post${i}` }));

    expect(() => compileGeneratedChildPlan(envelope, many, "Post0")).toThrow(
      new RoutineCompileError("plan_too_large", "/spec/states")
    );
  });

  it("denies a bound above the envelope's, even when below the global ceiling", () => {
    const fan: routineSchema.RoutineState = {
      type: "foreach",
      name: "Fan",
      items: "input.rows",
      body: "Post",
      maxItems: 50,
      maxConcurrency: 2,
      end: true,
    };

    expect(() =>
      compileGeneratedChildPlan(
        { ...envelope, allowedStateTypes: ["agent", "tool", "branch", "foreach"] },
        [fan, postTool],
        "Fan"
      )
    ).toThrow(new RoutineCompileError("bound_exceeds_ceiling", "/spec/states/0/maxItems"));
  });
});
