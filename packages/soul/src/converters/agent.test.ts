import { DEFINITION_REGISTRATIONS, SchemaRegistry } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { SoulAgent } from "../types";
import { convertLegacyAgent } from "./agent";

const registry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

function agentYaml(result: ReturnType<typeof convertLegacyAgent>): string {
  const file = result.files.find((f) => f.path.endsWith("agent.yaml"));
  if (file?.operation !== "upsert") throw new Error("agent.yaml not emitted");
  return file.content;
}

describe("convertLegacyAgent", () => {
  const validLegacy: SoulAgent = {
    name: "Support Bot",
    frontmatter: {
      owner: "team-support",
      modelProfile: "gpt-tier-1",
      autonomy: "propose_actions",
      trustTier: "business_authored",
      roles: ["support-agent"],
    },
    body: "# Support Bot\n\nHandles support tickets.",
  };

  it("converts the happy path into a validated agent.yaml + instructions.md", () => {
    const result = convertLegacyAgent(validLegacy);

    expect(result.warnings).toEqual([]);
    expect(result.files).toHaveLength(2);

    const agentFile = result.files.find((f) => f.path === "agents/support-bot/agent.yaml");
    const instructionsFile = result.files.find(
      (f) => f.path === "agents/support-bot/instructions.md"
    );
    expect(agentFile?.operation).toBe("upsert");
    expect(instructionsFile).toEqual({
      operation: "upsert",
      path: "agents/support-bot/instructions.md",
      content: validLegacy.body,
    });

    // GREEN proof: emitted YAML round-trips through the real AJV-backed registry validator.
    const validated = registry.validateYaml(agentYaml(result));
    expect(validated.kind).toBe("Agent");
    const document = validated.document as unknown as {
      spec: { owner: string; modelProfile: string; autonomy: string; trustTier: string };
      metadata: { slug: string; id: string };
    };
    expect(document.spec.owner).toBe("team-support");
    expect(document.metadata.slug).toBe("support-bot");
    expect(document.metadata.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("warns and drops unmapped frontmatter fields", () => {
    const result = convertLegacyAgent({
      ...validLegacy,
      frontmatter: { ...validLegacy.frontmatter, legacyOnlyField: "keep-me-out" },
    });

    expect(result.warnings).toContainEqual({ code: "UNMAPPED_FIELD", field: "legacyOnlyField" });
    const agentDoc = registry.validateYaml(agentYaml(result)).document as unknown as {
      spec: Record<string, unknown>;
    };
    expect(agentDoc.spec.legacyOnlyField).toBeUndefined();
  });

  it("never copies secret-shaped fields, even if they collide with an allowlisted name", () => {
    const result = convertLegacyAgent({
      ...validLegacy,
      frontmatter: {
        ...validLegacy.frontmatter,
        apiKey: "sk-should-never-appear",
        roles: "secret_token_value",
      },
    });

    expect(result.warnings).toContainEqual({ code: "SECRET_FIELD_DROPPED", field: "apiKey" });
    const yaml = agentYaml(result);
    expect(yaml).not.toContain("sk-should-never-appear");
  });

  it("skips emitting agent.yaml when a required field is missing, without inventing a default", () => {
    const { owner: _owner, ...rest } = validLegacy.frontmatter;
    const result = convertLegacyAgent({ ...validLegacy, frontmatter: rest });

    expect(result.files).toEqual([]);
    expect(result.warnings).toContainEqual({ code: "MISSING_REQUIRED_FIELD", field: "owner" });
  });

  it("is idempotent: same legacy input yields byte-identical files and warnings", () => {
    const first = convertLegacyAgent(validLegacy);
    const second = convertLegacyAgent(validLegacy);

    expect(second).toEqual(first);
    expect(agentYaml(second)).toBe(agentYaml(first));
  });
});
