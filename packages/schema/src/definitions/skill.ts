import { type Static, Type } from "@sinclair/typebox";
import {
  DEFINITION_TRUST_TIERS,
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

const safeRelativePathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$",
});

const skillCommandSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-z][a-z0-9]*(_[a-z0-9]+)*$",
    }),
    toolRef: Type.String({ minLength: 1, maxLength: 256 }),
    runtimeProfile: Type.String({ minLength: 1, maxLength: 128 }),
    entrypoint: safeRelativePathSchema,
    staticArgs: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })),
    requiredCommands: Type.Optional(refListSchema),
    integrationBindings: Type.Optional(
      Type.Array(
        Type.Object(
          {
            slot: Type.String({
              minLength: 1,
              maxLength: 64,
              pattern: "^[a-z][a-z0-9_]*$",
            }),
            integrationKinds: refListSchema,
            injectAs: Type.Object(
              {
                kind: Type.Unsafe<"file" | "environment">({
                  type: "string",
                  enum: ["file", "environment"],
                }),
                name: Type.String({
                  minLength: 1,
                  maxLength: 128,
                  pattern: "^[A-Z][A-Z0-9_]*$",
                }),
              },
              { additionalProperties: false }
            ),
          },
          { additionalProperties: false }
        ),
        {
          // V1 Tool intents carry one opaque Credential reference. A future multi-Credential intent
          // can widen this without changing the per-binding shape.
          maxItems: 1,
        }
      )
    ),
    fileOutputs: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({
              minLength: 1,
              maxLength: 128,
              pattern: "^[a-z][a-z0-9_]*$",
            }),
            path: safeRelativePathSchema,
            mediaTypes: refListSchema,
            maxBytes: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false }
        ),
        { maxItems: 32 }
      )
    ),
  },
  { additionalProperties: false }
);

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

const skillSpecSchema = Type.Object(
  {
    instructions: instructionsReferenceSchema,
    references: Type.Optional(refListSchema),
    templates: Type.Optional(refListSchema),
    examples: Type.Optional(refListSchema),
    // Paths to JSON Schema assets bundled with the Skill (SPEC §8.1 skills/<slug>/schemas).
    schemas: Type.Optional(refListSchema),
    assets: Type.Optional(refListSchema),
    // Sandboxed helper scripts; execution still traverses the sandbox + Tool Broker (SPEC §13).
    scripts: Type.Optional(refListSchema),
    // Named sandbox commands. Their ToolContract carries all authority and effect policy.
    commands: Type.Optional(Type.Array(skillCommandSchema, { minItems: 1, maxItems: 64 })),
    dependencies: Type.Optional(refListSchema),
    // Tool *abilities the Skill requires* — a declaration of need, never a grant of a Tool.
    requiredToolAbilities: Type.Optional(refListSchema),
    trustTier: Type.Unsafe<DefinitionTrustTier>({
      type: "string",
      enum: [...DEFINITION_TRUST_TIERS],
    }),
  },
  { additionalProperties: false }
);

export const SkillDefinitionSchema = definitionSchema(KIND, skillSpecSchema);

export const SKILL_DEFINITION = definitionRegistration(KIND, SkillDefinitionSchema);

export type SkillDefinition = Static<typeof SkillDefinitionSchema>;
export type SkillSpec = SkillDefinition["spec"];
export type SkillCommand = NonNullable<SkillSpec["commands"]>[number];
export type SkillCommandIntegrationBinding = NonNullable<
  SkillCommand["integrationBindings"]
>[number];
export type SkillCommandFileOutput = NonNullable<SkillCommand["fileOutputs"]>[number];
