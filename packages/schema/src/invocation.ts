/**
 * Request schemas for the persist-first invocation boundary.
 *
 * Every Run minted through the invocation gateway commits with an immutable Artifact holding the
 * request that produced it, validated against one of these schemas. They live here rather than in
 * `apps/api` because the worker that later reconstructs the Turn cannot import an app.
 */

/** A schema paired with the stable reference stored on the Artifact. */
export interface InvocationRequestSchema {
  readonly ref: string;
  readonly schema: Record<string, unknown>;
}

export const CHAT_REQUEST_SCHEMA_REF = "tulip.invocation.chat-request.v1";
export const MANUAL_REQUEST_SCHEMA_REF = "tulip.invocation.manual-request.v1";
export const INTEGRATION_REQUEST_SCHEMA_REF = "tulip.invocation.integration-request.v1";

/**
 * One interactive Chat turn as submitted. Also serves as the Fastify body schema for
 * `POST /api/v1/chat`, so the stored Artifact cannot drift from what the route accepts.
 */
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
        content: { type: "string", minLength: 1 },
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

/**
 * One verified Integration delivery, stored exactly as received.
 *
 * Provider-agnostic on purpose: the ingress route is driven entirely by the Integration manifest,
 * so Slack's Events API, Telegram webhooks, and any future channel all publish through this one
 * schema — adding a channel means adding a manifest, not a schema. Normalizing a delivery into a
 * Chat turn happens downstream and produces its own derived Artifact, which keeps the raw payload
 * replayable and auditable.
 */
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

/**
 * Every schema the gateway will accept. A `payloadSchemaRef` outside this set is denied, so a new
 * request shape cannot reach storage without being declared here first.
 */
export const INVOCATION_REQUEST_SCHEMAS: readonly InvocationRequestSchema[] = [
  { ref: CHAT_REQUEST_SCHEMA_REF, schema: CHAT_REQUEST_SCHEMA },
  { ref: MANUAL_REQUEST_SCHEMA_REF, schema: MANUAL_REQUEST_SCHEMA },
  { ref: INTEGRATION_REQUEST_SCHEMA_REF, schema: INTEGRATION_REQUEST_SCHEMA },
];
