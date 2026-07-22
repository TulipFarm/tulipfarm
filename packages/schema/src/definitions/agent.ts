import {
  AGENT_AUTONOMY_CEILINGS,
  type AgentAutonomyCeiling,
  DEFINITION_TRUST_TIERS,
  type DefinitionEnvelope,
  type DefinitionTrustTier,
  definitionRegistration,
  definitionSchema,
  MEMORY_SCOPES,
  type MemoryScope,
  refListSchema,
} from "./common";

/**
 * Agent authored definition (SPEC §7.1). Captures identity, owner/maintainers, assigned roles and
 * permission ceiling, personality, ModelProfile, Skill/Tool references, autonomy ceiling, limits,
 * data/delegation Guardrails, Memory/Knowledge scopes, trust tier, and evaluation suite.
 *
 * An Agent may reference Tools it is *allowed* to use, but the reference never grants authority:
 * effective authority is the intersection computed at runtime (SPEC §12). Permission never
 * broadens through an Agent, Skill, delegation, or team (invariant 3).
 */

const KIND = "Agent";

/** Deployment/role/Agent-level numeric limits (SPEC §9.1). The narrowest limit wins at runtime. */
const agentLimitsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    wallClockMs: { type: "integer", minimum: 0 },
    activeMs: { type: "integer", minimum: 0 },
    tokens: { type: "integer", minimum: 0 },
    costUsd: { type: "number", minimum: 0 },
    toolCalls: { type: "integer", minimum: 0 },
    delegationDepth: { type: "integer", minimum: 0 },
  },
} as const;

const agentSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: ["owner", "modelProfile", "autonomy", "trustTier"],
  properties: {
    owner: { type: "string", minLength: 1, maxLength: 256 },
    maintainers: refListSchema,
    personality: { type: "string", maxLength: 8192 },
    // Assigned Agent roles and the permission ceiling that bounds effective authority.
    roles: refListSchema,
    permissionCeiling: {
      type: "object",
      additionalProperties: false,
      properties: {
        grants: refListSchema,
        maxRiskClass: { type: "string", enum: ["low", "medium", "high"] },
      },
    },
    modelProfile: { type: "string", minLength: 1, maxLength: 256 },
    skills: refListSchema,
    // Tools the Agent is *allowed* to request; never a grant of authority.
    allowedTools: refListSchema,
    autonomy: { type: "string", enum: [...AGENT_AUTONOMY_CEILINGS] },
    limits: agentLimitsSchema,
    guardrails: {
      type: "object",
      additionalProperties: false,
      properties: {
        data: { type: "string", minLength: 1, maxLength: 256 },
        delegation: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    memoryScopes: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", enum: [...MEMORY_SCOPES] },
    },
    knowledgeScopes: refListSchema,
    trustTier: { type: "string", enum: [...DEFINITION_TRUST_TIERS] },
    // Evaluation suite gate (SPEC §10); action-capable Agents require it before publication.
    evaluationSuite: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

export const AgentDefinitionSchema = definitionSchema(KIND, agentSpecSchema);

export const AGENT_DEFINITION = definitionRegistration(KIND, AgentDefinitionSchema);

export interface AgentSpec {
  owner: string;
  maintainers?: string[];
  personality?: string;
  roles?: string[];
  permissionCeiling?: {
    grants?: string[];
    maxRiskClass?: "low" | "medium" | "high";
  };
  modelProfile: string;
  skills?: string[];
  allowedTools?: string[];
  autonomy: AgentAutonomyCeiling;
  limits?: {
    wallClockMs?: number;
    activeMs?: number;
    tokens?: number;
    costUsd?: number;
    toolCalls?: number;
    delegationDepth?: number;
  };
  guardrails?: { data?: string; delegation?: string };
  memoryScopes?: MemoryScope[];
  knowledgeScopes?: string[];
  trustTier: DefinitionTrustTier;
  evaluationSuite?: string;
}

export type AgentDefinition = DefinitionEnvelope<"Agent", AgentSpec>;
