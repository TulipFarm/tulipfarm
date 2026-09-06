import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";
import { modelPolicySchema } from "./definitions/common";
import { TulipFarmValidationError } from "./error";
import { TeamBusinessAssetOwnershipSchema } from "./teams";

/** AGENT.md frontmatter schema: write-time only, strict, and name comes from directory. */

export const AUTONOMY_VALUES = ["full", "supervised", "approval-required", "manual"] as const;
export const AGENT_RECORD_ACTIONS = [
  "list",
  "search",
  "read",
  "create",
  "update",
  "delete",
] as const;
export const AGENT_RESOURCE_TYPE_ACTIONS = ["list", "read", "create", "update"] as const;

const agentToolRestrictionsSchema = Type.Object(
  {
    allow: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    deny: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    allowMutating: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const agentActionRestrictionsSchema = <T extends readonly string[]>(values: T) =>
  Type.Object(
    {
      allow: Type.Optional(
        Type.Array(Type.Unsafe<T[number]>({ type: "string", enum: [...values] }))
      ),
      deny: Type.Optional(
        Type.Array(Type.Unsafe<T[number]>({ type: "string", enum: [...values] }))
      ),
    },
    { additionalProperties: false }
  );

const agentSkillRestrictionsSchema = Type.Object(
  {
    allow: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    deny: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false }
);

const AgentCapabilityRestrictionsSchema = Type.Object(
  {
    tools: Type.Optional(agentToolRestrictionsSchema),
    skills: Type.Optional(agentSkillRestrictionsSchema),
    records: Type.Optional(
      Type.Object(
        {
          actions: Type.Optional(agentActionRestrictionsSchema(AGENT_RECORD_ACTIONS)),
          resourceTypes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false }
      )
    ),
    resourceTypes: Type.Optional(
      Type.Object(
        {
          actions: Type.Optional(agentActionRestrictionsSchema(AGENT_RESOURCE_TYPE_ACTIONS)),
          names: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

export const AgentFrontmatterSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ minLength: 1 })),
    domain: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1, pattern: "^\\S+$" })),
    // Use enum, not union, so AJV emits self-correctable allowed-values errors.
    autonomy: Type.Optional(
      Type.Unsafe<(typeof AUTONOMY_VALUES)[number]>({ type: "string", enum: [...AUTONOMY_VALUES] })
    ),
    modelPolicy: Type.Optional(modelPolicySchema),
    capabilityRestrictions: Type.Optional(AgentCapabilityRestrictionsSchema),
    ownership: Type.Optional(TeamBusinessAssetOwnershipSchema),
    placeholder: Type.Optional(Type.Array(Type.String())),
    suggestions: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false }
);

export type AgentFrontmatter = Static<typeof AgentFrontmatterSchema>;
export type AgentCapabilityRestrictions = NonNullable<AgentFrontmatter["capabilityRestrictions"]>;

const check = ajv.compile(AgentFrontmatterSchema);

/** Validate AGENT.md frontmatter; throws `TulipFarmValidationError` on the first failure. */
export function validateAgentFrontmatter(frontmatter: unknown): AgentFrontmatter {
  if (!check(frontmatter)) {
    const e = check.errors?.[0];
    throw new TulipFarmValidationError(
      "agent",
      e?.instancePath ?? "",
      e?.message ?? "invalid agent frontmatter"
    );
  }
  return frontmatter as AgentFrontmatter;
}
