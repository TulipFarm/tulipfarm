/** Persist-first invocation request schemas; gateways must deny unregistered refs. */

/** A schema paired with the stable reference stored on the Artifact. */
export interface InvocationRequestSchema {
  readonly ref: string;
  readonly schema: Record<string, unknown>;
}

export const CHAT_REQUEST_SCHEMA_REF = "tulip.invocation.chat-request.v1";
export const MANUAL_REQUEST_SCHEMA_REF = "tulip.invocation.manual-request.v1";
export const INTEGRATION_REQUEST_SCHEMA_REF = "tulip.invocation.integration-request.v1";

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

/** Closed set of request schemas; gateways deny refs outside this registry. */
export const INVOCATION_REQUEST_SCHEMAS: readonly InvocationRequestSchema[] = [
  { ref: CHAT_REQUEST_SCHEMA_REF, schema: CHAT_REQUEST_SCHEMA },
  { ref: MANUAL_REQUEST_SCHEMA_REF, schema: MANUAL_REQUEST_SCHEMA },
  { ref: INTEGRATION_REQUEST_SCHEMA_REF, schema: INTEGRATION_REQUEST_SCHEMA },
];
