import type { SchemaRegistration } from "../registry";

/**
 * Shared building blocks for the canonical authored-definition schemas (Agent, Skill,
 * ToolContract, ModelProfile) registered in the AW-007 {@link SchemaRegistry}. Each schema
 * is a plain JSON Schema (draft 2020-12) that satisfies the registry's strict-object and
 * discriminator contracts: every object declares explicit unknown-property behaviour, and the
 * root pins `apiVersion`/`kind` with `const`.
 */

/** Single canonical API version for authored Soul definitions. */
export const DEFINITION_API_VERSION = "tulipfarm.ai/v1" as const;

/**
 * Authored lifecycle (SPEC §7.1). Editing a published definition creates a new version;
 * rollback activates a prior immutable version rather than rewriting history.
 */
export const DEFINITION_LIFECYCLE_STATES = [
  "draft",
  "validated",
  "simulated",
  "approved",
  "published",
  "active",
  "retired",
] as const;
export type DefinitionLifecycle = (typeof DEFINITION_LIFECYCLE_STATES)[number];

/**
 * Trust tiers shared by Agents and Skills (SPEC §10): first-party reviewed, business-authored,
 * and third-party/Agent-generated. Changed executable content is scanned and approved per
 * Guardrail according to tier.
 */
export const DEFINITION_TRUST_TIERS = ["first_party", "business_authored", "third_party"] as const;
export type DefinitionTrustTier = (typeof DEFINITION_TRUST_TIERS)[number];

/**
 * Autonomy ceilings (SPEC §11.1). None bypasses the Tool Broker; they are Guardrail presets over
 * the same broker, not alternate execution paths.
 */
export const AGENT_AUTONOMY_CEILINGS = [
  "answer_only",
  "propose_actions",
  "execute_low_risk",
  "execute_policy_authorized",
] as const;
export type AgentAutonomyCeiling = (typeof AGENT_AUTONOMY_CEILINGS)[number];

/** Memory scopes an Agent may address (SPEC §14.2). */
export const MEMORY_SCOPES = [
  "user_private",
  "user_agent",
  "agent_private",
  "team_role",
  "business",
  "run_local",
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Base risk classification of a Tool effect (SPEC §11.1–§11.2). */
export const TOOL_RISK_CLASSES = ["low", "medium", "high"] as const;
export type ToolRiskClass = (typeof TOOL_RISK_CLASSES)[number];

/** How a Tool's stable idempotency key is honoured (SPEC §11.3). */
export const TOOL_IDEMPOTENCY_STRATEGIES = ["provider", "reconcile", "none"] as const;
export type ToolIdempotencyStrategy = (typeof TOOL_IDEMPOTENCY_STRATEGIES)[number];

/** Implementation backends a Tool contract can bind to (SPEC §11.1, §15). */
export const TOOL_ADAPTER_KINDS = [
  "native",
  "integration",
  "mcp",
  "openapi",
  "http",
  "sandbox",
  "postgres",
] as const;
export type ToolAdapterKind = (typeof TOOL_ADAPTER_KINDS)[number];

/** Reasoning/effort level requested from a model (SPEC §17). */
export const MODEL_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ModelReasoningLevel = (typeof MODEL_REASONING_LEVELS)[number];

/** Data-retention posture a ModelProfile requires of its provider (SPEC §17). */
export const MODEL_DATA_RETENTION = ["none", "zero_retention", "provider_default"] as const;
export type ModelDataRetention = (typeof MODEL_DATA_RETENTION)[number];

/** ULID (Crockford base32) or canonical UUID. */
const ID_PATTERN =
  "^([0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$";
/** Lowercase kebab-case human slug. */
const SLUG_PATTERN = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
/** Lowercase hex sha-256 digest. */
const DIGEST_PATTERN = "^[a-f0-9]{64}$";

/**
 * Common envelope every authored definition carries (SPEC §7.1): stable identifier, human slug,
 * schema version, authored version, lifecycle state, and immutable published digest.
 */
export const definitionMetadataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "slug", "schemaVersion", "authoredVersion", "lifecycle"],
  properties: {
    id: { type: "string", pattern: ID_PATTERN },
    slug: { type: "string", pattern: SLUG_PATTERN, maxLength: 128 },
    displayName: { type: "string", minLength: 1, maxLength: 256 },
    schemaVersion: { type: "integer", minimum: 1 },
    authoredVersion: { type: "integer", minimum: 1 },
    lifecycle: { type: "string", enum: [...DEFINITION_LIFECYCLE_STATES] },
    publishedDigest: { type: "string", pattern: DIGEST_PATTERN },
  },
} as const;

/** A non-empty array of unique reference strings (slugs or IDs of other definitions). */
export const refListSchema = {
  type: "array",
  uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 256 },
} as const;

/**
 * Wrap a `spec` schema in the strict discriminated root every authored definition shares.
 * The root pins `apiVersion`/`kind` and forbids unknown top-level keys.
 */
export function definitionSchema(
  kind: string,
  spec: Record<string, unknown>
): Record<string, unknown> {
  return {
    $id: `${DEFINITION_API_VERSION}/${kind}`,
    type: "object",
    additionalProperties: false,
    required: ["apiVersion", "kind", "metadata", "spec"],
    properties: {
      apiVersion: { const: DEFINITION_API_VERSION },
      kind: { const: kind },
      metadata: definitionMetadataSchema,
      spec,
    },
  };
}

/** Registration payload for the {@link SchemaRegistry}. */
export function definitionRegistration(
  kind: string,
  schema: Record<string, unknown>
): SchemaRegistration {
  return { apiVersion: DEFINITION_API_VERSION, kind, schema };
}

/** Shape shared by every validated authored definition. */
export interface DefinitionMetadata {
  id: string;
  slug: string;
  displayName?: string;
  schemaVersion: number;
  authoredVersion: number;
  lifecycle: DefinitionLifecycle;
  publishedDigest?: string;
}

export interface DefinitionEnvelope<Kind extends string, Spec> {
  apiVersion: typeof DEFINITION_API_VERSION;
  kind: Kind;
  metadata: DefinitionMetadata;
  spec: Spec;
}
