/**
 * Plain enum constants shared by the Soul definitions, with no TypeBox import.
 *
 * They live apart from `common.ts` because importing one of them should not cost a validator. The
 * browser reaches `MODEL_MODALITIES` through `model-catalog`, and while these sat beside the schema
 * builders that single constant pulled 42KB of TypeBox onto the web app's critical path.
 * `common.ts` re-exports everything here, so importing from either module is equivalent.
 */

/** Single canonical API version for authored Soul definitions. */
export const DEFINITION_API_VERSION = "tulipfarm.ai/v1" as const;

/** Authored lifecycle; published edits version, while rollback activates prior versions. */
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

/** Trust tiers shared by Agents and Skills; executable changes are reviewed by tier. */
export const DEFINITION_TRUST_TIERS = ["first_party", "business_authored", "third_party"] as const;
export type DefinitionTrustTier = (typeof DEFINITION_TRUST_TIERS)[number];

/** Autonomy ceilings are Guardrail presets; none bypass the Tool Broker. */
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

/**
 * Implementation backends a Tool contract can bind to (SPEC §11.1, §15). A kind belongs here only
 * while a registered adapter can serve it: `EffectDispatcher` refuses a contract whose declared
 * kind is not the kind of the adapter its ref resolves to, so an unserved kind is a Tool that
 * validates at install and can never dispatch.
 *
 * `native` is served by the Tool host rather than the effect plane; `mcp` is emitted by the import
 * proposal path and has no adapter yet. Both are pinned as declaration-only by
 * `scripts/adapter-kind-dispatch.test.ts`, which fails the build on a new unserved kind.
 */
export const TOOL_ADAPTER_KINDS = [
  "native",
  "integration",
  "mcp",
  "openapi",
  "graphql",
  "sandbox",
] as const;
export type ToolAdapterKind = (typeof TOOL_ADAPTER_KINDS)[number];

/** Reasoning/effort level requested from a model (SPEC §17). */
export const MODEL_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ModelReasoningLevel = (typeof MODEL_REASONING_LEVELS)[number];

/** Data-retention posture a ModelProfile requires of its provider (SPEC §17). */
export const MODEL_DATA_RETENTION = ["none", "zero_retention", "provider_default"] as const;
export type ModelDataRetention = (typeof MODEL_DATA_RETENTION)[number];

/** Model modalities are dimensions; unsupported modality is a denial, never silent dropping. */
export const MODEL_MODALITIES = ["text", "image", "audio", "video", "document"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

/** Lowercase kebab-case human slug. */
export const SLUG_PATTERN = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";

/** Canonical `secret://` reference pattern; excludes bare keys, env vars, and traversal refs. */
export const SECRET_REFERENCE_PATTERN =
  "^secret://[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*$";

const SECRET_REFERENCE_REGEX = new RegExp(SECRET_REFERENCE_PATTERN);

/** True when `value` is a `secret://` reference rather than an inline credential. */
export function isSecretReference(value: string): boolean {
  return SECRET_REFERENCE_REGEX.test(value);
}
