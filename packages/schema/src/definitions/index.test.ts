import { describe, expect, it } from "vitest";
import { definitions } from "../index";
import { SchemaRegistry } from "../registry";
import { DEFINITION_API_VERSION, DEFINITION_KINDS, DEFINITION_REGISTRATIONS } from "./index";

describe("Authored definition registry integration", () => {
  it("registers every canonical authored kind in one registry without collision", () => {
    expect(() => new SchemaRegistry(DEFINITION_REGISTRATIONS)).not.toThrow();
  });

  it("exposes every authored definition kind through the public registry", () => {
    expect([...DEFINITION_KINDS]).toEqual([
      "Agent",
      "Skill",
      "ToolContract",
      "ModelProfile",
      "Routine",
      "Trigger",
      "Role",
      "Guardrail",
      "Settings",
      "IntegrationAdapter",
      "App",
      "Integration",
      "AccessGrant",
      "KnowledgeSource",
      "MemorySettings",
      "Form",
      "A2UITemplate",
    ]);
    expect(DEFINITION_REGISTRATIONS.map((r) => r.kind)).toEqual([...DEFINITION_KINDS]);
  });

  it("owns every registration at the single canonical api version", () => {
    for (const registration of DEFINITION_REGISTRATIONS) {
      expect(registration.apiVersion).toBe(DEFINITION_API_VERSION);
    }
  });

  it("produces a deterministic canonical hash across registry restarts", () => {
    const doc = {
      apiVersion: DEFINITION_API_VERSION,
      kind: "ModelProfile",
      metadata: {
        id: "44444444-4444-4444-4444-444444444444",
        slug: "sol-high",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: {
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoning: "high",
        supports: { tools: true, structuredOutput: true, contextWindowTokens: 400000 },
        allowCaching: false,
      },
    };
    const first = new SchemaRegistry(DEFINITION_REGISTRATIONS).validate(doc);
    const second = new SchemaRegistry(DEFINITION_REGISTRATIONS).validate(doc);
    expect(first.hash).toBe(second.hash);
  });
});

describe("definitions namespace", () => {
  it("exposes the routine, trigger, and event validators without colliding with legacy exports", () => {
    expect(typeof definitions.routine.validateRoutineDefinition).toBe("function");
    expect(typeof definitions.trigger.validateTriggerDefinition).toBe("function");
    expect(typeof definitions.event.validateEventEnvelope).toBe("function");
    expect(definitions.routine.ROUTINE_STATE_TYPES).toContain("agent");
    expect(definitions.trigger.TRIGGER_TYPES).toContain("webhook");
    expect(definitions.event.EVENT_VERIFICATION_STATUSES).toContain("verified");
  });
});
