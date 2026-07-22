import { describe, expect, it } from "vitest";
import { SchemaRegistry } from "../registry";
import { DEFINITION_API_VERSION, DEFINITION_KINDS, DEFINITION_REGISTRATIONS } from "./index";

describe("Authored definition registry integration", () => {
  it("registers all four canonical kinds in one registry without collision", () => {
    expect(() => new SchemaRegistry(DEFINITION_REGISTRATIONS)).not.toThrow();
  });

  it("exposes exactly the Agent, Skill, ToolContract, and ModelProfile kinds", () => {
    expect([...DEFINITION_KINDS]).toEqual(["Agent", "Skill", "ToolContract", "ModelProfile"]);
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
