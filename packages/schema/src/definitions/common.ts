import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { SchemaRegistration } from "../registry";

/**
 * Shared building blocks for the canonical authored-definition schemas (Agent, Skill,
 * ToolContract, ModelProfile) registered in the {@link SchemaRegistry}. Each schema is built with
 * TypeBox and satisfies the registry's strict-object and discriminator contracts: every object
 * declares explicit unknown-property behaviour, and the root pins `apiVersion`/`kind` with `const`.
 *
 * TypeBox is used so a schema and the type describing its validated output cannot drift: the type
 * is *derived* from the schema with `Static<>`, never written a second time by hand. Where a schema
 * shape TypeBox does not emit natively is required — notably `enum`, which `Type.Union` would emit
 * as `anyOf` — use `Type.Unsafe<T>` over a literal, with both `T` and the literal derived from the
 * same `as const` array so the single source of truth survives.
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

/**
 * Content kinds a model can accept or produce (SPEC §17). Modality is a *dimension*, not a rung on
 * the capability ladder: an image model is not "more" than a text model, it is a different one. A
 * turn that needs a modality no profile supports is a denial, never a silent send to a model that
 * would drop the content.
 */
export const MODEL_MODALITIES = ["text", "image", "audio", "video"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

/** ULID (Crockford base32) or canonical UUID. */
const ID_PATTERN =
  "^([0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$";
/** Lowercase kebab-case human slug. */
const SLUG_PATTERN = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
/** Lowercase hex sha-256 digest. */
const DIGEST_PATTERN = "^[a-f0-9]{64}$";

/**
 * Canonical secret *reference* shape, shared by every authored definition that names credential
 * material and by the execution-bundle compiler that refuses to store the material itself.
 *
 * `secret://` plus non-empty slash-separated segments; each segment starts and ends
 * alphanumerically and may contain `.`, `_`, `-` between. This deliberately excludes bare secret
 * keys (`webhook.github.secret`), env var names (`GITHUB_SECRET`), and traversal-shaped refs.
 *
 * Declared once here because the authoring boundary and the publication boundary must agree: a
 * value the schema accepts but the compiler rejects is authorable yet unpublishable, and under
 * auto-publish that wedges every later Soul change behind it.
 */
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

/**
 * Common envelope every authored definition carries (SPEC §7.1): stable identifier, human slug,
 * schema version, authored version, lifecycle state, and immutable published digest.
 */
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

/**
 * Wrap a `spec` schema in the strict discriminated root every authored definition shares.
 * The root pins `apiVersion`/`kind` and forbids unknown top-level keys.
 *
 * Generic over the `spec` schema so `Static<>` on the result yields the whole validated
 * definition — envelope and spec together — with no hand-written counterpart to fall out of date.
 */
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
