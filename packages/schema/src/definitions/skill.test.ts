import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "../errors";
import { SchemaRegistry } from "../registry";
import { DEFINITION_API_VERSION } from "./common";
import { SKILL_DEFINITION, SKILL_FORBIDDEN_GRANT_KEYS, SkillDefinitionSchema } from "./skill";

function skillSpecPropertyNames(): string[] {
  const root = SkillDefinitionSchema as {
    properties: { spec: { properties: Record<string, unknown> } };
  };
  return Object.keys(root.properties.spec.properties);
}

function registry(): SchemaRegistry {
  return new SchemaRegistry([SKILL_DEFINITION]);
}

const metadata = {
  id: "22222222-2222-2222-2222-222222222222",
  slug: "issue-triage",
  schemaVersion: 1,
  authoredVersion: 1,
  lifecycle: "draft",
};

const minimal = {
  apiVersion: DEFINITION_API_VERSION,
  kind: "Skill",
  metadata,
  spec: { trustTier: "third_party" },
};

const full = {
  apiVersion: DEFINITION_API_VERSION,
  kind: "Skill",
  metadata,
  spec: {
    references: ["docs/triage.md"],
    templates: ["reply.hbs"],
    examples: ["example-1.md"],
    schemas: ["schemas/input.json"],
    assets: ["logo.png"],
    scripts: ["scripts/classify.ts"],
    dependencies: ["shared-utils"],
    requiredToolAbilities: ["github.issue.label"],
    trustTier: "first_party",
  },
};

describe("Skill definition schema", () => {
  it("registers without violating the strict-object or discriminator contract", () => {
    expect(() => registry()).not.toThrow();
  });

  it("validates a fully populated Skill definition", () => {
    expect(() => registry().validate(full)).not.toThrow();
  });

  it("validates a minimal Skill with only a trust tier", () => {
    expect(() => registry().validate(minimal)).not.toThrow();
  });

  it("allows required Tool abilities as a declaration of need", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, requiredToolAbilities: ["mailer.send"] } };
    expect(() => registry().validate(doc)).not.toThrow();
  });

  // Invariant 4: a Skill never contains a permission grant.
  it.each(SKILL_FORBIDDEN_GRANT_KEYS)("fails closed when a Skill smuggles a %s grant", (key) => {
    const doc = { ...minimal, spec: { ...minimal.spec, [key]: ["github.issue.delete"] } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("never declares a grant-shaped property in its own spec schema", () => {
    const specProps = skillSpecPropertyNames();
    for (const forbidden of SKILL_FORBIDDEN_GRANT_KEYS) {
      expect(specProps).not.toContain(forbidden);
    }
  });

  it("rejects an unknown trust tier", () => {
    const doc = { ...minimal, spec: { trustTier: "internal" } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects a missing trust tier", () => {
    const doc = { ...minimal, spec: {} };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });
});
