import { DEFINITION_API_VERSION } from "@tulipfarm/schema";
import { stringify } from "yaml";
import type { SoulFileChange } from "../changeset";
import type { SoulSkill } from "../types";
import { type ConversionResult, deriveDefinitionId, mapAllowlistedFields, slugify } from "./shared";

const KIND = "Skill";

/** `SkillSpec` fields sourced from legacy frontmatter (`instructions` is always derived, never copied). */
const SKILL_FRONTMATTER_ALLOWLIST = [
  "references",
  "templates",
  "examples",
  "schemas",
  "assets",
  "scripts",
  "commands",
  "dependencies",
  "requiredToolAbilities",
  "trustTier",
] as const;

const SKILL_REQUIRED_FIELDS = ["trustTier"] as const;

/**
 * Convert a legacy `SoulSkill` (SKILL.md frontmatter + body) into a proposed authored `Skill`
 * definition (`skills/<slug>/skill.yaml` + companion `SKILL.md`). Never publishes; the caller
 * decides whether/how to route the returned files through the changeset gateway.
 */
export function convertLegacySkill(skill: SoulSkill): ConversionResult {
  const slug = slugify(skill.name);
  const { mapped, warnings } = mapAllowlistedFields(skill.frontmatter, SKILL_FRONTMATTER_ALLOWLIST);

  const missing = SKILL_REQUIRED_FIELDS.filter((field) => mapped[field] === undefined);
  if (missing.length > 0) {
    return {
      files: [],
      warnings: [
        ...warnings,
        ...missing.map((field) => ({ code: "MISSING_REQUIRED_FIELD" as const, field })),
      ],
    };
  }

  const spec: Record<string, unknown> = { instructions: { path: "SKILL.md" } };
  if (mapped.references !== undefined) spec.references = mapped.references;
  if (mapped.templates !== undefined) spec.templates = mapped.templates;
  if (mapped.examples !== undefined) spec.examples = mapped.examples;
  if (mapped.schemas !== undefined) spec.schemas = mapped.schemas;
  if (mapped.assets !== undefined) spec.assets = mapped.assets;
  if (mapped.scripts !== undefined) spec.scripts = mapped.scripts;
  if (mapped.commands !== undefined) spec.commands = mapped.commands;
  if (mapped.dependencies !== undefined) spec.dependencies = mapped.dependencies;
  if (mapped.requiredToolAbilities !== undefined) {
    spec.requiredToolAbilities = mapped.requiredToolAbilities;
  }
  spec.trustTier = mapped.trustTier;

  const document = {
    apiVersion: DEFINITION_API_VERSION,
    kind: KIND,
    metadata: {
      id: deriveDefinitionId(KIND, skill.name),
      slug,
      displayName: skill.name,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "draft",
    },
    spec,
  };

  const files: SoulFileChange[] = [
    {
      operation: "upsert",
      path: `skills/${slug}/skill.yaml`,
      content: stringify(document),
    },
    {
      operation: "upsert",
      path: `skills/${slug}/SKILL.md`,
      content: skill.body,
    },
  ];

  return { files, warnings };
}
