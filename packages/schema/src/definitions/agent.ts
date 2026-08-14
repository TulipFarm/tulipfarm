import { type Static, Type } from "@sinclair/typebox";
import {
  AGENT_AUTONOMY_CEILINGS,
  type AgentAutonomyCeiling,
  DEFINITION_TRUST_TIERS,
  type DefinitionTrustTier,
  definitionRegistration,
  definitionSchema,
  instructionsReferenceSchema,
  MEMORY_SCOPES,
  type MemoryScope,
  refListSchema,
} from "./common";

/** Agent definition; Tool refs are allowlists, never authority grants. */

const KIND = "Agent";

/** Deployment/role/Agent-level numeric limits (SPEC §9.1). The narrowest limit wins at runtime. */
const agentLimitsSchema = Type.Object(
  {
    wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })),
    activeMs: Type.Optional(Type.Integer({ minimum: 0 })),
    tokens: Type.Optional(Type.Integer({ minimum: 0 })),
    costUsd: Type.Optional(Type.Number({ minimum: 0 })),
    toolCalls: Type.Optional(Type.Integer({ minimum: 0 })),
    delegationDepth: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);

const agentSpecSchema = Type.Object(
  {
    owner: Type.String({ minLength: 1, maxLength: 256 }),
    maintainers: Type.Optional(refListSchema),
    instructions: instructionsReferenceSchema,
    personality: Type.Optional(Type.String({ maxLength: 8192 })),
    // Assigned Agent roles and the permission ceiling that bounds effective authority.
    roles: Type.Optional(refListSchema),
    permissionCeiling: Type.Optional(
      Type.Object(
        {
          grants: Type.Optional(refListSchema),
          maxRiskClass: Type.Optional(
            Type.Unsafe<"low" | "medium" | "high">({
              type: "string",
              enum: ["low", "medium", "high"],
            })
          ),
        },
        { additionalProperties: false }
      )
    ),
    modelProfile: Type.String({ minLength: 1, maxLength: 256 }),
    skills: Type.Optional(refListSchema),
    // Tools the Agent is *allowed* to request; never a grant of authority.
    allowedTools: Type.Optional(refListSchema),
    autonomy: Type.Unsafe<AgentAutonomyCeiling>({
      type: "string",
      enum: [...AGENT_AUTONOMY_CEILINGS],
    }),
    limits: Type.Optional(agentLimitsSchema),
    guardrails: Type.Optional(
      Type.Object(
        {
          data: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          delegation: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        },
        { additionalProperties: false }
      )
    ),
    memoryScopes: Type.Optional(
      Type.Array(Type.Unsafe<MemoryScope>({ type: "string", enum: [...MEMORY_SCOPES] }), {
        uniqueItems: true,
      })
    ),
    knowledgeScopes: Type.Optional(refListSchema),
    trustTier: Type.Unsafe<DefinitionTrustTier>({
      type: "string",
      enum: [...DEFINITION_TRUST_TIERS],
    }),
    // Evaluation suite gate (SPEC §10); action-capable Agents require it before publication.
    evaluationSuite: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false }
);

export const AgentDefinitionSchema = definitionSchema(KIND, agentSpecSchema);

export const AGENT_DEFINITION = definitionRegistration(KIND, AgentDefinitionSchema);

export type AgentDefinition = Static<typeof AgentDefinitionSchema>;
export type AgentSpec = AgentDefinition["spec"];
