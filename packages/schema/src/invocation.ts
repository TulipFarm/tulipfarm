/** Persist-first invocation request schemas; gateways must deny unregistered refs. */

import { type Static, Type } from "@sinclair/typebox";

/** A schema paired with the stable reference stored on the Artifact. */
export interface InvocationRequestSchema {
  readonly ref: string;
  readonly schema: Record<string, unknown>;
}

export const CHAT_REQUEST_SCHEMA_REF = "tulip.invocation.chat-request.v1";
export const MANUAL_REQUEST_SCHEMA_REF = "tulip.invocation.manual-request.v1";
export const INTEGRATION_REQUEST_SCHEMA_REF = "tulip.invocation.integration-request.v1";
export const CURATOR_REQUEST_SCHEMA_REF = "tulip.invocation.curator-request.v1";

/** Why a user has durable Curator work waiting. Onboarding is lifelong, so not all are reactive. */
export const CURATOR_WORK_REASONS = [
  "turn_completed",
  "proposal_resolved",
  "daily_refresh_due",
  "proposal_seed_ready",
] as const;
export type CuratorWorkReason = (typeof CURATOR_WORK_REASONS)[number];

/** Chat request schema shared by storage and `POST /api/v1/chat`. */
export const CHAT_REQUEST_SCHEMA = {
  type: "object",
  required: ["message"],
  additionalProperties: false,
  properties: {
    conversationId: { type: "string" },
    message: {
      type: "object",
      required: ["role", "content"],
      additionalProperties: false,
      properties: {
        role: { type: "string", enum: ["user"] },
        /**
         * May be empty only when `fileIds` is not: an image on its own is a whole question, and
         * "what is this?" is often typed by the attachment rather than the keyboard. The route
         * rejects a message that is empty of both.
         */
        content: { type: "string" },
        /**
         * Files already uploaded by this caller, to be attached to the message.
         *
         * Ids rather than parts: the stored Message is an ordered part list, but letting a client
         * author that list directly would let it invent part kinds and interleave text it did not
         * type. The server builds the parts and re-checks that each File is one the caller may
         * read, because an id from a client is a claim, not a capability.
         */
        fileIds: {
          type: "array",
          maxItems: 10,
          items: { type: "string", minLength: 1 },
        },
      },
    },
    model: { type: "string", minLength: 1, pattern: "^\\S+$" },
    agentId: { type: "string", minLength: 1 },
    autonomy: { type: "string", enum: ["full", "supervised", "approval-required", "manual"] },
    hasTools: { type: "boolean" },
    llmDecision: { type: "boolean" },
    skills: { type: "array", items: { type: "string", minLength: 1 } },
    resources: { type: "array", items: { type: "string", minLength: 1 } },
    knowledgePages: { type: "array", maxItems: 10, items: { type: "string", minLength: 1 } },
    clientContext: {
      type: "object",
      additionalProperties: false,
      properties: { route: { type: "string" }, title: { type: "string" } },
    },
  },
} as const;

/** A Routine triggered by name with resolved inputs. */
export const MANUAL_REQUEST_SCHEMA = {
  type: "object",
  required: ["slug", "inputs"],
  additionalProperties: false,
  properties: {
    slug: { type: "string", minLength: 1 },
    inputs: { type: "object" },
  },
} as const;

/** Verified Integration delivery stored raw; channel behavior comes from the manifest. */
export const INTEGRATION_REQUEST_SCHEMA = {
  type: "object",
  required: ["slug", "body"],
  additionalProperties: false,
  properties: {
    slug: { type: "string", minLength: 1 },
    body: { type: "object" },
    headers: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

const SHA256_HEX = Type.String({ pattern: "^[0-9a-f]{64}$" });
const ID_LIST = Type.Array(Type.String({ minLength: 1 }), { maxItems: 200 });

/**
 * Curator Run request. The request Artifact is append-only with non-expiring retention, so this
 * payload names references only — never transcripts, quotes or the Memory Document. The executor
 * fetches content at execution time through `GET /internal/curator/context`, which erasure reaches.
 */
const CURATOR_USER_REQUEST = Type.Object(
  {
    jobId: Type.String({ minLength: 1 }),
    scope: Type.Unsafe<"user">({ type: "string", enum: ["user"] }),
    subjectUserId: Type.String({ minLength: 1 }),
    reasons: Type.Array(
      Type.Unsafe<CuratorWorkReason>({ type: "string", enum: CURATOR_WORK_REASONS }),
      { minItems: 1 }
    ),
    turnIds: Type.Optional(ID_LIST),
    proposalIds: Type.Optional(ID_LIST),
    seedIds: Type.Optional(ID_LIST),
    memoryRevisionId: Type.Optional(Type.String({ minLength: 1 })),
    memoryRevisionHash: Type.Optional(SHA256_HEX),
    inputDigest: SHA256_HEX,
  },
  { additionalProperties: false }
);

/** Business reasoning aggregates several people, so its branch cannot name an audience. */
const CURATOR_BUSINESS_REQUEST = Type.Object(
  {
    jobId: Type.String({ minLength: 1 }),
    scope: Type.Unsafe<"business">({ type: "string", enum: ["business"] }),
    soulDigest: Type.Optional(SHA256_HEX),
    candidateIds: Type.Optional(ID_LIST),
    inputDigest: SHA256_HEX,
  },
  { additionalProperties: false }
);

const CURATOR_REQUEST = Type.Union([CURATOR_USER_REQUEST, CURATOR_BUSINESS_REQUEST]);

export type CuratorUserRequest = Static<typeof CURATOR_USER_REQUEST>;
export type CuratorBusinessRequest = Static<typeof CURATOR_BUSINESS_REQUEST>;
export type CuratorRequest = Static<typeof CURATOR_REQUEST>;

export const CURATOR_REQUEST_SCHEMA = CURATOR_REQUEST as unknown as Record<string, unknown>;

/** Closed set of request schemas; gateways deny refs outside this registry. */
export const INVOCATION_REQUEST_SCHEMAS: readonly InvocationRequestSchema[] = [
  { ref: CHAT_REQUEST_SCHEMA_REF, schema: CHAT_REQUEST_SCHEMA },
  { ref: MANUAL_REQUEST_SCHEMA_REF, schema: MANUAL_REQUEST_SCHEMA },
  { ref: INTEGRATION_REQUEST_SCHEMA_REF, schema: INTEGRATION_REQUEST_SCHEMA },
  { ref: CURATOR_REQUEST_SCHEMA_REF, schema: CURATOR_REQUEST_SCHEMA },
];
