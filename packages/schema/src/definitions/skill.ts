import {
  DEFINITION_TRUST_TIERS,
  type DefinitionEnvelope,
  type DefinitionTrustTier,
  definitionRegistration,
  definitionSchema,
  instructionsReferenceSchema,
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

const safeRelativePathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$",
} as const;

const skillCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "toolRef", "runtimeProfile", "entrypoint"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-z][a-z0-9]*(_[a-z0-9]+)*$",
    },
    toolRef: { type: "string", minLength: 1, maxLength: 256 },
    runtimeProfile: { type: "string", minLength: 1, maxLength: 128 },
    entrypoint: safeRelativePathSchema,
    staticArgs: {
      type: "array",
      maxItems: 64,
      items: { type: "string", maxLength: 512 },
    },
    requiredCommands: refListSchema,
    integrationBindings: {
      type: "array",
      // V1 Tool intents carry one opaque Credential reference. A future multi-Credential intent
      // can widen this without changing the per-binding shape.
      maxItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slot", "integrationKinds", "injectAs"],
        properties: {
          slot: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^[a-z][a-z0-9_]*$",
          },
          integrationKinds: refListSchema,
          injectAs: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "name"],
            properties: {
              kind: { type: "string", enum: ["file", "environment"] },
              name: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^[A-Z][A-Z0-9_]*$",
              },
            },
          },
        },
      },
    },
    fileOutputs: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "path", "mediaTypes", "maxBytes"],
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[a-z][a-z0-9_]*$",
          },
          path: safeRelativePathSchema,
          mediaTypes: refListSchema,
          maxBytes: { type: "integer", minimum: 1 },
        },
      },
    },
  },
} as const;

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
  required: ["instructions", "trustTier"],
  properties: {
    instructions: instructionsReferenceSchema,
    references: refListSchema,
    templates: refListSchema,
    examples: refListSchema,
    // Paths to JSON Schema assets bundled with the Skill (SPEC §8.1 skills/<slug>/schemas).
    schemas: refListSchema,
    assets: refListSchema,
    // Sandboxed helper scripts; execution still traverses the sandbox + Tool Broker (SPEC §13).
    scripts: refListSchema,
    // Named sandbox commands. Their ToolContract carries all authority and effect policy.
    commands: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: skillCommandSchema,
    },
    dependencies: refListSchema,
    // Tool *abilities the Skill requires* — a declaration of need, never a grant of a Tool.
    requiredToolAbilities: refListSchema,
    trustTier: { type: "string", enum: [...DEFINITION_TRUST_TIERS] },
  },
} as const;

export const SkillDefinitionSchema = definitionSchema(KIND, skillSpecSchema);

export const SKILL_DEFINITION = definitionRegistration(KIND, SkillDefinitionSchema);

export interface SkillSpec {
  instructions: { path: string };
  references?: string[];
  templates?: string[];
  examples?: string[];
  schemas?: string[];
  assets?: string[];
  scripts?: string[];
  commands?: SkillCommand[];
  dependencies?: string[];
  requiredToolAbilities?: string[];
  trustTier: DefinitionTrustTier;
}

export interface SkillCommandIntegrationBinding {
  slot: string;
  integrationKinds: string[];
  injectAs: { kind: "file" | "environment"; name: string };
}

export interface SkillCommandFileOutput {
  name: string;
  path: string;
  mediaTypes: string[];
  maxBytes: number;
}

export interface SkillCommand {
  name: string;
  toolRef: string;
  runtimeProfile: string;
  entrypoint: string;
  staticArgs?: string[];
  requiredCommands?: string[];
  integrationBindings?: SkillCommandIntegrationBinding[];
  fileOutputs?: SkillCommandFileOutput[];
}

export type SkillDefinition = DefinitionEnvelope<"Skill", SkillSpec>;
