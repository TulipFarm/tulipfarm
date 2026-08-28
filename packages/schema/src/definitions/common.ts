import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { SchemaRegistration } from "../registry";

/** Shared TypeBox definition blocks; derive types via `Static<>` and use enum, not `anyOf`. */

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

/**
 * Governance an Agent's turns require of whatever model serves them.
 *
 * Shared by both Agent surfaces — `AGENT.md` frontmatter and the Agent Definition — so the thing
 * an operator may author and the thing the Definition can express cannot drift apart.
 *
 * A demand here is matched against what a provider entry declares it satisfies. An entry that
 * declares nothing is treated as unverifiable, not permissive, so a demand denies it.
 */
export const modelPolicySchema = Type.Object(
  {
    residency: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    dataRetention: Type.Optional(
      Type.Unsafe<ModelDataRetention>({ type: "string", enum: [...MODEL_DATA_RETENTION] })
    ),
    allowTraining: Type.Optional(Type.Boolean()),
    maxLatencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Sensitive work keeps caching off regardless of what the profile permits (SPEC §17). */
    sensitive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

/** Model modalities are dimensions; unsupported modality is a denial, never silent dropping. */
export const MODEL_MODALITIES = ["text", "image", "audio", "video", "document"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

/** ULID (Crockford base32) or canonical UUID. */
const ID_PATTERN =
  "^([0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$";
/** Lowercase kebab-case human slug. */
export const SLUG_PATTERN = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
/** Lowercase hex sha-256 digest. */
const DIGEST_PATTERN = "^[a-f0-9]{64}$";

/** Canonical `secret://` reference pattern; excludes bare keys, env vars, and traversal refs. */
export const SECRET_REFERENCE_PATTERN =
  "^secret://[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*$";

const SECRET_REFERENCE_REGEX = new RegExp(SECRET_REFERENCE_PATTERN);

/** True when `value` is a `secret://` reference rather than an inline credential. */
export function isSecretReference(value: string): boolean {
  return SECRET_REFERENCE_REGEX.test(value);
}

/** A schema field that must hold a `secret://` reference, never the secret itself. */
export const secretReferenceSchema = Type.String({
  pattern: SECRET_REFERENCE_PATTERN,
  maxLength: 512,
});

/** Common authored-definition envelope. */
export const definitionMetadataSchema = Type.Object(
  {
    id: Type.String({ pattern: ID_PATTERN }),
    slug: Type.String({ pattern: SLUG_PATTERN, maxLength: 128 }),
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    schemaVersion: Type.Integer({ minimum: 1 }),
    authoredVersion: Type.Integer({ minimum: 1 }),
    lifecycle: Type.Unsafe<DefinitionLifecycle>({
      type: "string",
      enum: [...DEFINITION_LIFECYCLE_STATES],
    }),
    publishedDigest: Type.Optional(Type.String({ pattern: DIGEST_PATTERN })),
  },
  { additionalProperties: false }
);

/** Shape shared by every validated authored definition. */
export type DefinitionMetadata = Static<typeof definitionMetadataSchema>;

/** A non-empty array of unique reference strings (slugs or IDs of other definitions). */
export const refListSchema = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
  uniqueItems: true,
});

/** Reference to governed Markdown content stored beside its owning Soul definition. */
export const instructionsReferenceSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^/].*\\.md$" }),
  },
  { additionalProperties: false }
);

/** Wrap `spec` in the strict `apiVersion`/`kind` root so `Static<>` derives the full type. */
export function definitionSchema<Kind extends string, Spec extends TSchema>(
  kind: Kind,
  spec: Spec
) {
  return Type.Object(
    {
      apiVersion: Type.Literal(DEFINITION_API_VERSION),
      kind: Type.Literal(kind),
      metadata: definitionMetadataSchema,
      spec,
    },
    { $id: `${DEFINITION_API_VERSION}/${kind}`, additionalProperties: false }
  );
}

/** Registration payload for the {@link SchemaRegistry}. */
export function definitionRegistration(kind: string, schema: TSchema): SchemaRegistration {
  return { apiVersion: DEFINITION_API_VERSION, kind, schema };
}

export interface DefinitionEnvelope<Kind extends string, Spec> {
  apiVersion: typeof DEFINITION_API_VERSION;
  kind: Kind;
  metadata: DefinitionMetadata;
  spec: Spec;
}
