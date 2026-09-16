import { describe, expect, it } from "vitest";
import { validatePlanDefinition, YAML_PLAN_MAX_STEPS } from "./plan";

const plan = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Plan",
  name: "customer-report",
  version: 1,
  steps: [{ id: "Fetch", tool: "record_search" }],
};

describe("PlanDefinitionSchema", () => {
  it("accepts a hybrid Plan with JSON inputs and Agent output requirements", () => {
    const document = {
      ...plan,
      steps: [
        {
          id: "Fetch",
          tool: "record_search",
          input: { nested: [null, true, 1, { key: "value" }] },
        },
        {
          id: "Draft",
          needs: ["Fetch"],
          agent: { name: "writer", version: "2.1.0" },
          prompt: "Summarize the records",
          requiredToolCalls: ["record_search"],
          output: { type: "object", additionalProperties: false },
        },
        { id: "Publish", needs: ["Draft"], routine: { name: "publish", version: "3" } },
      ],
    };
    expect(validatePlanDefinition(document).document).toEqual(document);
  });

  it.each([
    { extra: "no" },
    { apiVersion: "tulipfarm.ai/v2" },
    { kind: "Routine" },
    { name: "../escape" },
    { version: 0 },
    { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { steps: [] },
    { steps: Array.from({ length: YAML_PLAN_MAX_STEPS + 1 }, () => plan.steps[0]) },
  ])("rejects an invalid envelope: %j", (override) => {
    expect(() => validatePlanDefinition({ ...plan, ...override })).toThrow();
  });

  it.each([
    { id: "_Fetch", tool: "read" },
    { id: "Fetch", tool: "" },
    { id: "Fetch" },
    { id: "Fetch", tool: "read", agent: { name: "writer", version: "1" }, prompt: "Write" },
    { id: "Fetch", agent: { name: "writer", version: "1" } },
    { id: "Fetch", agent: { name: "writer" }, prompt: "Write" },
    { id: "Fetch", routine: { name: "writer" } },
    { id: "Fetch", routine: { name: "writer", version: 1 } },
    { id: "Fetch", agent: { name: "writer", version: "1", grants: ["all"] }, prompt: "Write" },
    { id: "Fetch", tool: "read", needs: ["Other", "Other"] },
    { id: "Fetch", tool: "read", input: [] },
    { id: "Fetch", tool: "read", prompt: "not an agent" },
    { id: "Fetch", tool: "read", identity: { principalId: "admin" } },
    { id: "Fetch", script: "return true" },
    { id: "Fetch", include: "https://example.com/plan.yaml" },
  ])("rejects an invalid step: %j", (step) => {
    expect(() => validatePlanDefinition({ ...plan, steps: [step] })).toThrow();
  });
});
