import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { agentOutputSchema, planAgentInvocation } from "./agent";
import { RoutineStepError } from "./step";
import { compileStates, compileWithTargets } from "./test-support";

function agentState(overrides: Record<string, unknown> = {}): routineSchema.RoutineState {
  return {
    type: "agent",
    name: "Classify",
    agentRef: { name: "triage", version: "1.0.0" },
    input: { subject: `\${input.subject}`, locale: "en" },
    end: true,
    ...overrides,
  } as routineSchema.RoutineState;
}

describe("planAgentInvocation", () => {
  it("plans the authored Agent with its question resolved from the Context", () => {
    const plan = planAgentInvocation(compileWithTargets(agentState()), {
      input: { subject: "invoice overdue" },
    });

    expect(plan.agentRef).toEqual({ name: "triage", version: "1.0.0" });
    expect(plan.input).toEqual({ subject: "invoice overdue", locale: "en" });
    expect(plan.outputSchemaRef).toBeNull();
    expect(plan.maxRepairAttempts).toBeUndefined();
  });

  it("carries the authored repair budget rather than inventing one", () => {
    const plan = planAgentInvocation(compileWithTargets(agentState({ maxRepairAttempts: 3 })), {
      input: { subject: "invoice overdue" },
    });

    expect(plan.maxRepairAttempts).toBe(3);
  });

  it("replays to the same question, so a resumed Run asks what the first attempt asked", () => {
    const state = compileWithTargets(agentState());
    const scope = { input: { subject: "invoice overdue" } };

    expect(planAgentInvocation(state, scope)).toEqual(planAgentInvocation(state, scope));
  });

  it("names the declared output schema the answer must satisfy", () => {
    const routine = compileStates(
      [
        agentState({
          output: { type: "object", required: ["category"], properties: { category: {} } },
        }),
      ],
      "Classify"
    );
    const state = routine.states.get("Classify");
    if (state === undefined) throw new Error("missing Classify");

    const plan = planAgentInvocation(state, { input: { subject: "s" } });
    expect(plan.outputSchemaRef).toBe(state.outputSchemaRef);
    expect(agentOutputSchema(routine.outputSchemas, plan.outputSchemaRef)).toEqual({
      type: "object",
      required: ["category"],
      properties: { category: {} },
    });
  });

  it("has no schema to enforce when the State declared none", () => {
    expect(agentOutputSchema([], null)).toBeUndefined();
  });

  it("refuses a State whose authored Agent reference is unusable", () => {
    const state = compileWithTargets(agentState());
    const definition: routineSchema.RoutineState = {
      type: "tool",
      name: "Classify",
      toolRef: { name: "github.issue.comment", version: "1.0.0" },
      action: "issue.comment",
      end: true,
    };
    const withoutRef = { ...state, definition };

    expect(() => planAgentInvocation(withoutRef, {})).toThrow(
      new RoutineStepError("missing_agent_ref", "Classify")
    );
  });

  it("refuses to plan a State that is not an Agent State", () => {
    const tool = compileWithTargets({
      type: "tool",
      name: "Comment",
      toolRef: { name: "github.issue.comment", version: "1.0.0" },
      action: "issue.comment",
      end: true,
    } as routineSchema.RoutineState);

    expect(() => planAgentInvocation(tool, {})).toThrow(RoutineStepError);
  });
});
