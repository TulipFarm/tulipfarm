import { describe, expect, it } from "vitest";
import { routineDefinitionReferences, unresolvedRoutineDefinitions } from "./definition-references";

function spec(states: unknown[]) {
  return { owner: "ops", start: "First", states };
}

const agentState = {
  name: "Run",
  type: "agent",
  agentRef: { name: "joke-bot", version: "1" },
  end: true,
};

describe("routineDefinitionReferences", () => {
  it("collects the reference each State type carries", () => {
    const references = routineDefinitionReferences(
      spec([
        agentState,
        { name: "Call", type: "tool", toolRef: { name: "acme.notify", version: "1" }, action: "x" },
        {
          name: "Child",
          type: "child_routine",
          routineRef: { name: "sub", version: "1" },
          mode: "sync",
        },
        { name: "Ask", type: "form", formRef: { name: "intake", version: "1" } },
        { name: "Pick", type: "branch", conditions: [{ condition: "true", end: true }] },
      ])
    );

    expect(references).toEqual([
      { kind: "Agent", name: "joke-bot", state: "Run" },
      { kind: "ToolContract", name: "acme.notify", state: "Call" },
      { kind: "Routine", name: "sub", state: "Child" },
      { kind: "Form", name: "intake", state: "Ask" },
    ]);
  });

  it("ignores malformed States and refs rather than guessing", () => {
    expect(routineDefinitionReferences(spec([null, { type: "agent" }, { name: "A" }]))).toEqual([]);
    expect(routineDefinitionReferences({ states: "not-an-array" })).toEqual([]);
  });
});

describe("unresolvedRoutineDefinitions", () => {
  it("passes a Routine with no State references", () => {
    const states = [
      { name: "First", type: "branch", conditions: [{ condition: "true", end: true }] },
    ];
    expect(unresolvedRoutineDefinitions(spec(states), {})).toBeUndefined();
  });

  it("refuses an Agent the Soul does not have and names the tool that creates one", () => {
    const refusal = unresolvedRoutineDefinitions(spec([agentState]), { agents: new Map() });

    expect(refusal?.code).toBe("validation_error");
    expect(refusal?.message).toContain("joke-bot");
    expect(refusal?.message).toContain("agent_create");
    expect(refusal?.message).toContain("The Soul has no Agents yet.");
  });

  it("lists the Agents that do exist so the caller can pick one", () => {
    const refusal = unresolvedRoutineDefinitions(spec([agentState]), {
      agents: new Map([
        ["support", {}],
        ["ops", {}],
      ]),
    });

    expect(refusal?.message).toContain("Existing Agents: ops, support.");
  });

  it("accepts an Agent the Soul has", () => {
    const known = { agents: new Map([["joke-bot", {}]]) };
    expect(unresolvedRoutineDefinitions(spec([agentState]), known)).toBeUndefined();
  });

  it("refuses a child_routine State naming a Routine that does not exist", () => {
    const states = [
      {
        name: "Child",
        type: "child_routine",
        routineRef: { name: "sub", version: "1" },
        mode: "sync",
      },
    ];
    const refusal = unresolvedRoutineDefinitions(spec(states), { routines: new Map() });

    expect(refusal?.message).toContain("No Routine named sub");
  });

  it("refuses a tool State naming a Tool the runtime hosts, and points at an agent State", () => {
    const states = [
      {
        name: "Delegate",
        type: "tool",
        toolRef: { name: "delegate_to_agent", version: "1" },
        action: "delegate_to_agent",
      },
    ];
    const refusal = unresolvedRoutineDefinitions(spec(states), {
      runtimeToolNames: new Set(["delegate_to_agent", "record_search"]),
    });

    expect(refusal?.message).toContain("delegate_to_agent");
    expect(refusal?.message).toContain("not a Soul ToolContract");
    expect(refusal?.message).toContain('"agent" State');
  });

  it("leaves an unrecognised toolRef to the Soul writer's semantic pass", () => {
    const states = [
      {
        name: "Call",
        type: "tool",
        toolRef: { name: "acme.notify", version: "1" },
        action: "send",
      },
    ];
    const known = { runtimeToolNames: new Set(["record_search"]) };
    expect(unresolvedRoutineDefinitions(spec(states), known)).toBeUndefined();
  });

  it("reports every unreachable reference in one message", () => {
    const states = [
      agentState,
      {
        name: "Delegate",
        type: "tool",
        toolRef: { name: "record_search", version: "1" },
        action: "record_search",
      },
    ];
    const refusal = unresolvedRoutineDefinitions(spec(states), {
      agents: new Map(),
      runtimeToolNames: new Set(["record_search"]),
    });

    expect(refusal?.message).toContain("record_search");
    expect(refusal?.message).toContain("joke-bot");
  });
});
