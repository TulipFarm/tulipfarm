import { DEFINITION_REGISTRATIONS, SchemaRegistry } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { SoulSkill } from "../types";
import { convertLegacySkill } from "./skill";

const registry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

function skillYaml(result: ReturnType<typeof convertLegacySkill>): string {
  const file = result.files.find((f) => f.path.endsWith("skill.yaml"));
  if (file?.operation !== "upsert") throw new Error("skill.yaml not emitted");
  return file.content;
}

describe("convertLegacySkill", () => {
  const validLegacy: SoulSkill = {
    name: "PDF Summarizer",
    frontmatter: {
      trustTier: "first_party",
      requiredToolAbilities: ["read_file"],
    },
    body: "# PDF Summarizer\n\nSummarizes PDFs.",
  };

  it("converts the happy path into a validated skill.yaml + SKILL.md", () => {
    const result = convertLegacySkill(validLegacy);

    expect(result.warnings).toEqual([]);
    expect(result.files).toHaveLength(2);

    const instructionsFile = result.files.find((f) => f.path === "skills/pdf-summarizer/SKILL.md");
    expect(instructionsFile).toEqual({
      operation: "upsert",
      path: "skills/pdf-summarizer/SKILL.md",
      content: validLegacy.body,
    });

    const validated = registry.validateYaml(skillYaml(result));
    expect(validated.kind).toBe("Skill");
    const document = validated.document as unknown as {
      spec: { trustTier: string };
      metadata: { slug: string };
    };
    expect(document.spec.trustTier).toBe("first_party");
    expect(document.metadata.slug).toBe("pdf-summarizer");
  });

  it("warns and drops unmapped frontmatter fields", () => {
    const result = convertLegacySkill({
      ...validLegacy,
      frontmatter: { ...validLegacy.frontmatter, unknownLegacyKey: 1 },
    });

    expect(result.warnings).toContainEqual({ code: "UNMAPPED_FIELD", field: "unknownLegacyKey" });
  });

  it("never copies secret-shaped fields", () => {
    const result = convertLegacySkill({
      ...validLegacy,
      frontmatter: { ...validLegacy.frontmatter, credentialRef: "should-not-appear" },
    });

    expect(result.warnings).toContainEqual({
      code: "SECRET_FIELD_DROPPED",
      field: "credentialRef",
    });
    expect(skillYaml(result)).not.toContain("should-not-appear");
  });

  it("skips emitting skill.yaml when trustTier is missing", () => {
    const { trustTier: _trustTier, ...rest } = validLegacy.frontmatter;
    const result = convertLegacySkill({ ...validLegacy, frontmatter: rest });

    expect(result.files).toEqual([]);
    expect(result.warnings).toContainEqual({ code: "MISSING_REQUIRED_FIELD", field: "trustTier" });
  });

  it("is idempotent: same legacy input yields byte-identical files and warnings", () => {
    const first = convertLegacySkill(validLegacy);
    const second = convertLegacySkill(validLegacy);

    expect(second).toEqual(first);
    expect(skillYaml(second)).toBe(skillYaml(first));
  });
});
