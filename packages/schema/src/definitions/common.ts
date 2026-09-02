import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { SchemaRegistration } from "../registry";
import {
  DEFINITION_API_VERSION,
  DEFINITION_LIFECYCLE_STATES,
  type DefinitionLifecycle,
  MODEL_DATA_RETENTION,
  type ModelDataRetention,
  SECRET_REFERENCE_PATTERN,
  SLUG_PATTERN,
} from "./enums";

export * from "./enums";

/** Shared TypeBox definition blocks; derive types via `Static<>` and use enum, not `anyOf`. */

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

/** ULID (Crockford base32) or canonical UUID. */
const ID_PATTERN =
  "^([0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$";
/** Lowercase hex sha-256 digest. */
const DIGEST_PATTERN = "^[a-f0-9]{64}$";

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
