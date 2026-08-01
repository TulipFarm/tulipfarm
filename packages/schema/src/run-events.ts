/**
 * The Run event vocabulary — what a Run tells the world while it executes.
 *
 * Every observer reads this one stream: the web client, a Slack or Telegram renderer, an operator
 * console, and any channel added later. It is therefore deliberately channel-neutral — no vendor
 * wire format, no assumption that the reader can render partial tokens — because these rows are
 * also the permanent record of what the Run did, and a transport protocol baked into an audit log
 * outlives the transport.
 *
 * The schemas live here rather than in an app because the writer (the worker) and the readers
 * (the API's stream adapter, channel renderers) sit on opposite sides of an application boundary
 * and cannot import each other.
 */

/**
 * Who an event may be shown to. `participant` is what the person in the conversation sees;
 * `operator` is evidence — digests, dispatch records, guardrail decisions — that belongs to
 * whoever operates the deployment. Listing requires audiences explicitly, so an event is withheld
 * unless the reader was granted its audience.
 */
export type RunEventAudience = "participant" | "operator";

/** One event type, its audience, and the schema its payload must satisfy. */
export interface RunEventDefinition {
  readonly type: RunEventType;
  readonly audience: RunEventAudience;
  readonly schema: Record<string, unknown>;
}

/** A schema paired with the stable reference an event payload is validated against. */
export interface RunEventSchema {
  readonly ref: string;
  readonly schema: Record<string, unknown>;
}

export const RUN_EVENT_TYPES = [
  "turn.started",
  "text.delta",
  "tool.call",
  "tool.result",
  "surface.emitted",
  "approval.requested",
  "guardrail.blocked",
  "turn.finished",
  "context.assembled",
  "tool.dispatched",
  "guardrail.decision",
  "delivery.classified",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** The reference an event payload is validated under, e.g. `tulip.run-event.text-delta.v1`. */
export function runEventSchemaRef(type: RunEventType): string {
  return `tulip.run-event.${type.replace(".", "-")}.v1`;
}

const TURN_STARTED_SCHEMA = {
  type: "object",
  required: ["turnId", "attempt", "agentId"],
  additionalProperties: false,
  properties: {
    turnId: { type: "string", minLength: 1 },
    attempt: { type: "integer", minimum: 0 },
    agentId: { type: "string", minLength: 1 },
    conversationId: { type: "string", minLength: 1 },
  },
} as const;

/**
 * A span of assistant text. Deltas are chunked rather than per-token: a channel that cannot render
 * partial words gains nothing from token granularity, and one durable row per token would make the
 * audit log mostly noise. `index` orders spans within an attempt independently of the Run-wide
 * sequence, so a reader can reassemble the text without assuming it saw every other event type.
 */
const TEXT_DELTA_SCHEMA = {
  type: "object",
  required: ["text", "index"],
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    index: { type: "integer", minimum: 0 },
  },
} as const;

/**
 * A Tool call the participant is allowed to know happened. Arguments are carried as a digest, not
 * verbatim: they routinely hold the protected data the call operates on, and a participant stream
 * is the wrong place to reproduce it. The full arguments live in the operator-audience
 * `tool.dispatched` evidence.
 */
const TOOL_CALL_SCHEMA = {
  type: "object",
  required: ["callId", "name", "argsDigest"],
  additionalProperties: false,
  properties: {
    callId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    argsDigest: { type: "string", minLength: 1 },
  },
} as const;

const TOOL_RESULT_SCHEMA = {
  type: "object",
  required: ["callId", "status"],
  additionalProperties: false,
  properties: {
    callId: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["ok", "error"] },
    summary: { type: "string" },
    errorCode: { type: "string", minLength: 1 },
  },
} as const;

const SURFACE_EMITTED_SCHEMA = {
  type: "object",
  required: ["artifactId"],
  additionalProperties: false,
  properties: {
    artifactId: { type: "string", minLength: 1 },
    componentId: { type: "string", minLength: 1 },
  },
} as const;

/**
 * The turn is parked on a durable wait. The same Run resumes when the wait is signalled.
 *
 * `callId` names the Tool call being held, so a reader can show the decision against the call it
 * belongs to instead of as a free-floating prompt. It is the id from the participant's own
 * `tool.call` event — never the Tool's arguments, which stay behind the digest.
 */
const APPROVAL_REQUESTED_SCHEMA = {
  type: "object",
  required: ["waitId", "intentId"],
  additionalProperties: false,
  properties: {
    waitId: { type: "string", minLength: 1 },
    intentId: { type: "string", minLength: 1 },
    callId: { type: "string", minLength: 1 },
    summary: { type: "string" },
  },
} as const;

const GUARDRAIL_BLOCKED_SCHEMA = {
  type: "object",
  required: ["stage", "reason"],
  additionalProperties: false,
  properties: {
    stage: { type: "string", enum: ["input", "tool_call", "output"] },
    reason: { type: "string", minLength: 1 },
    guard: { type: "string", minLength: 1 },
  },
} as const;

/**
 * The terminal event. `messageId` is null when the turn produced no assistant Message — a block, a
 * failure, or a cancellation — so a reader never has to infer absence from a missing field.
 */
const TURN_FINISHED_SCHEMA = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["succeeded", "failed", "cancelled"] },
    messageId: { type: ["string", "null"] },
    reason: { type: "string" },
    usage: {
      type: "object",
      additionalProperties: false,
      properties: {
        inputTokens: { type: "integer", minimum: 0 },
        outputTokens: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

/** Operator evidence: what the model was actually given, by digest rather than by content. */
const CONTEXT_ASSEMBLED_SCHEMA = {
  type: "object",
  required: ["contextDigest", "guardrailDigest"],
  additionalProperties: false,
  properties: {
    contextDigest: { type: "string", minLength: 1 },
    guardrailDigest: { type: "string", minLength: 1 },
    messageCount: { type: "integer", minimum: 0 },
    compacted: { type: "boolean" },
    modelProfileId: { type: "string", minLength: 1 },
  },
} as const;

/** Operator evidence: the dispatch record a duplicate delivery is reconciled against. */
const TOOL_DISPATCHED_SCHEMA = {
  type: "object",
  required: ["callId", "name", "idempotencyKey"],
  additionalProperties: false,
  properties: {
    callId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    idempotencyKey: { type: "string", minLength: 1 },
    intentId: { type: "string", minLength: 1 },
    effect: { type: "string", enum: ["read", "write"] },
    outcome: { type: "string", enum: ["applied", "duplicate", "ambiguous", "failed"] },
  },
} as const;

/**
 * Operator evidence for every guardrail stage, including the ones that passed. A record of blocks
 * alone cannot show that a guard ran at all, which is exactly what an audit needs to establish.
 */
const GUARDRAIL_DECISION_SCHEMA = {
  type: "object",
  required: ["stage", "guard", "decision"],
  additionalProperties: false,
  properties: {
    stage: { type: "string", enum: ["input", "tool_call", "output"] },
    guard: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ["pass", "transform", "block"] },
    reason: { type: "string" },
  },
} as const;

/**
 * Operator evidence: what an Integration's classifier decided about one delivery.
 *
 * Most deliveries a channel sends are not questions — a reaction, a bot's own message, an event
 * type nobody subscribed to — and a Run that answers none of them still has to say why it did
 * nothing. Without this row, an operator asking "why did Slack not reply?" can only see a Run that
 * succeeded silently, which is indistinguishable from one that was never delivered.
 */
const DELIVERY_CLASSIFIED_SCHEMA = {
  type: "object",
  required: ["decision"],
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["ignore", "chat", "event", "invalid"] },
    reason: { type: "string" },
    eventType: { type: "string", minLength: 1 },
  },
} as const;

/**
 * Every event a Run may emit. A type outside this set is refused before it can be appended, so the
 * durable stream cannot grow a shape no reader was built to understand.
 */
export const RUN_EVENT_DEFINITIONS: readonly RunEventDefinition[] = [
  { type: "turn.started", audience: "participant", schema: TURN_STARTED_SCHEMA },
  { type: "text.delta", audience: "participant", schema: TEXT_DELTA_SCHEMA },
  { type: "tool.call", audience: "participant", schema: TOOL_CALL_SCHEMA },
  { type: "tool.result", audience: "participant", schema: TOOL_RESULT_SCHEMA },
  { type: "surface.emitted", audience: "participant", schema: SURFACE_EMITTED_SCHEMA },
  { type: "approval.requested", audience: "participant", schema: APPROVAL_REQUESTED_SCHEMA },
  { type: "guardrail.blocked", audience: "participant", schema: GUARDRAIL_BLOCKED_SCHEMA },
  { type: "turn.finished", audience: "participant", schema: TURN_FINISHED_SCHEMA },
  { type: "context.assembled", audience: "operator", schema: CONTEXT_ASSEMBLED_SCHEMA },
  { type: "tool.dispatched", audience: "operator", schema: TOOL_DISPATCHED_SCHEMA },
  { type: "guardrail.decision", audience: "operator", schema: GUARDRAIL_DECISION_SCHEMA },
  { type: "delivery.classified", audience: "operator", schema: DELIVERY_CLASSIFIED_SCHEMA },
];

/** The three points a guardrail can refuse a turn, shared by the block and decision records. */
export type RunEventGuardrailStage = "input" | "tool_call" | "output";

/**
 * The payload each event type carries, matching its schema field for field.
 *
 * A writer still validates against the schema — these types bind the two sides at compile time but
 * cannot police a payload assembled from runtime data. Optional fields must be **omitted**, never
 * set to `undefined`: the schemas are `additionalProperties: false`, and a present-but-undefined
 * property is a property.
 */
export interface RunEventPayloads {
  readonly "turn.started": {
    readonly turnId: string;
    readonly attempt: number;
    readonly agentId: string;
    readonly conversationId?: string;
  };
  readonly "text.delta": { readonly text: string; readonly index: number };
  readonly "tool.call": {
    readonly callId: string;
    readonly name: string;
    readonly argsDigest: string;
  };
  readonly "tool.result": {
    readonly callId: string;
    readonly status: "ok" | "error";
    readonly summary?: string;
    readonly errorCode?: string;
  };
  readonly "surface.emitted": { readonly artifactId: string; readonly componentId?: string };
  readonly "approval.requested": {
    readonly waitId: string;
    readonly intentId: string;
    readonly callId?: string;
    readonly summary?: string;
  };
  readonly "guardrail.blocked": {
    readonly stage: RunEventGuardrailStage;
    readonly reason: string;
    readonly guard?: string;
  };
  readonly "turn.finished": {
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly messageId?: string | null;
    readonly reason?: string;
    readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  };
  readonly "context.assembled": {
    readonly contextDigest: string;
    readonly guardrailDigest: string;
    readonly messageCount?: number;
    readonly compacted?: boolean;
    readonly modelProfileId?: string;
  };
  readonly "tool.dispatched": {
    readonly callId: string;
    readonly name: string;
    readonly idempotencyKey: string;
    readonly intentId?: string;
    readonly effect?: "read" | "write";
    readonly outcome?: "applied" | "duplicate" | "ambiguous" | "failed";
  };
  readonly "guardrail.decision": {
    readonly stage: RunEventGuardrailStage;
    readonly guard: string;
    readonly decision: "pass" | "transform" | "block";
    readonly reason?: string;
  };
  readonly "delivery.classified": {
    readonly decision: "ignore" | "chat" | "event" | "invalid";
    readonly reason?: string;
    readonly eventType?: string;
  };
}

const DEFINITIONS_BY_TYPE = new Map<string, RunEventDefinition>(
  RUN_EVENT_DEFINITIONS.map((definition) => [definition.type, definition])
);

/** The definition for an event type, or undefined if the type is not part of the vocabulary. */
export function runEventDefinition(type: string): RunEventDefinition | undefined {
  return DEFINITIONS_BY_TYPE.get(type);
}

/** Registrations for a validator, in the shape `TypedOutputValidator` accepts. */
export const RUN_EVENT_SCHEMAS: readonly RunEventSchema[] = RUN_EVENT_DEFINITIONS.map(
  (definition) => ({
    ref: runEventSchemaRef(definition.type),
    schema: definition.schema as unknown as Record<string, unknown>,
  })
);
