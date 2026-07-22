import {
  DEFINITION_TRUST_TIERS,
  type DefinitionEnvelope,
  type DefinitionTrustTier,
  definitionRegistration,
  definitionSchema,
  refListSchema,
} from "./common";

/**
 * Skill authored definition (SPEC §7.1, invariant 4). A Skill contains instructions and assets and
 * *declares* the Tool abilities it needs; it NEVER contains a permission grant, Tool grant, role,
 * or access grant. Authority comes only from the invoking user/Agent intersection at runtime — a
 * Skill can never add it (invariant 3). `additionalProperties: false` fails closed on any attempt
 * to smuggle a grant-shaped field into a Skill.
 */

const KIND = "Skill";

/** Property names that would turn a Skill into an authority grant. Kept for the guard test. */
export const SKILL_FORBIDDEN_GRANT_KEYS = [
  "grants",
  "grant",
  "permissions",
  "permission",
  "permissionCeiling",
  "roles",
  "role",
  "toolGrants",
  "grantedTools",
  "accessGrants",
  "accessGrant",
  "credentials",
] as const;

const skillSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: ["trustTier"],
  properties: {
    references: refListSchema,
    templates: refListSchema,
    examples: refListSchema,
    // Paths to JSON Schema assets bundled with the Skill (SPEC §8.1 skills/<slug>/schemas).
    schemas: refListSchema,
    assets: refListSchema,
    // Sandboxed helper scripts; execution still traverses the sandbox + Tool Broker (SPEC §13).
    scripts: refListSchema,
    dependencies: refListSchema,
    // Tool *abilities the Skill requires* — a declaration of need, never a grant of a Tool.
    requiredToolAbilities: refListSchema,
    trustTier: { type: "string", enum: [...DEFINITION_TRUST_TIERS] },
  },
} as const;

export const SkillDefinitionSchema = definitionSchema(KIND, skillSpecSchema);

export const SKILL_DEFINITION = definitionRegistration(KIND, SkillDefinitionSchema);

export interface SkillSpec {
  references?: string[];
  templates?: string[];
  examples?: string[];
  schemas?: string[];
  assets?: string[];
  scripts?: string[];
  dependencies?: string[];
  requiredToolAbilities?: string[];
  trustTier: DefinitionTrustTier;
}

export type SkillDefinition = DefinitionEnvelope<"Skill", SkillSpec>;
