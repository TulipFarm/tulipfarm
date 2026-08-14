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

import { MODEL_PROFILE_DENIAL_REASONS } from "./definitions/model";
import { EFFORT_PRESETS, EFFORT_RUNGS, type EffortPreset, type EffortRung } from "./model-catalog";

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
  "model.routed",
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
 * A bounded, redaction-aware view of a Tool's arguments or output.
 *
 * The digest alone told a participant that a call happened and nothing about what it did, which
 * made a Tool row unreadable to the person the Tool acted for. A preview closes that gap without
 * reopening the one the digest was protecting: it is built where the values already live (the
 * dispatch boundary), every withheld leaf is replaced rather than dropped, and `redactedPaths`
 * names each one so a reader can show that something was withheld instead of silently rendering a
 * hole. `truncated` reports that the preview is not the whole value, so a reader never presents a
 * partial result as complete.
 *
 * `json` is JSON text rather than a nested schema because Tool arguments have no common shape and
 * a schema permissive enough to hold all of them would constrain nothing.
 */
export const TOOL_PREVIEW_SCHEMA = {
  type: "object",
  required: ["json"],
  additionalProperties: false,
  properties: {
    json: { type: "string" },
    redactedPaths: { type: "array", items: { type: "string", minLength: 1 } },
    truncated: { type: "boolean" },
    bytes: { type: "integer", minimum: 0 },
  },
} as const;

export const PARTICIPANT_TOOL_CALL_SCHEMA = {
  type: "object",
  required: ["callId", "name"],
  additionalProperties: false,
  properties: {
    callId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    argsDigest: { type: "string", minLength: 1 },
    argsPreview: TOOL_PREVIEW_SCHEMA,
    resultPreview: TOOL_PREVIEW_SCHEMA,
    durationMs: { type: "integer", minimum: 0 },
    outcome: { type: "string", enum: ["ok", "error"] },
    errorCode: { type: "string", minLength: 1 },
  },
} as const;

export const MESSAGE_METADATA_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    toolCalls: { type: "array", items: PARTICIPANT_TOOL_CALL_SCHEMA },
  },
} as const;

/**
 * A Tool call the participant is allowed to know happened.
 *
 * `argsDigest` stays required and stays the record of what was actually called: it hashes the
 * verbatim arguments, so it still identifies them exactly after a preview has redacted or
 * truncated them. `argsPreview` is the readable companion, never the authority. The full verbatim
 * arguments remain operator-audience only, in `tool.dispatched`.
 *
 * `tier`, `mutating`, `agentId` and `stepId` are identity rather than content — they say which
 * kind of Tool ran, whether it could write, and which Agent and State it belonged to — so a reader
 * can group and rank calls without being told what the call operated on.
 */
const TOOL_CALL_SCHEMA = {
  type: "object",
  required: ["callId", "name", "argsDigest"],
  additionalProperties: false,
  properties: {
    callId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    argsDigest: { type: "string", minLength: 1 },
    argsPreview: TOOL_PREVIEW_SCHEMA,
    tier: { type: "string", enum: ["system", "platform", "integration"] },
    mutating: { type: "boolean" },
    agentId: { type: "string", minLength: 1 },
    stepId: { type: "string", minLength: 1 },
    startedAt: { type: "string", minLength: 1 },
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
    resultPreview: TOOL_PREVIEW_SCHEMA,
    durationMs: { type: "integer", minimum: 0 },
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
    modelId: { type: "string", minLength: 1 },
    effortPreset: { type: "string", enum: EFFORT_PRESETS },
    effortApplied: { type: "string", enum: EFFORT_RUNGS },
    modelCallLatencyMs: { type: "integer", minimum: 0 },
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

const MODEL_ROUTED_ATTEMPT_SCHEMA = {
  type: "object",
  required: ["profileId", "reason"],
  additionalProperties: false,
  properties: {
    profileId: { type: "string", minLength: 1 },
    reason: { type: "string", enum: MODEL_PROFILE_DENIAL_REASONS },
  },
} as const;

const MODEL_ROUTED_CHAIN_ENTRY_SCHEMA = {
  type: "object",
  required: ["profileId", "modelId"],
  additionalProperties: false,
  properties: {
    profileId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
  },
} as const;

const MODEL_ROUTED_BUDGET_LIMIT_SCHEMA = {
  type: "object",
  required: ["value", "scope"],
  additionalProperties: false,
  properties: {
    value: { type: "integer", minimum: 0 },
    scope: {
      type: "string",
      enum: [
        "deployment",
        "role",
        "agent",
        "routine",
        "run",
        "state",
        "tool",
        "integration",
        "model",
      ],
    },
  },
} as const;

const MODEL_ROUTED_BUDGET_LIMITS_SCHEMA = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    tokens: MODEL_ROUTED_BUDGET_LIMIT_SCHEMA,
    costMicros: MODEL_ROUTED_BUDGET_LIMIT_SCHEMA,
  },
} as const;

/**
 * How a selector became a ModelProfile.
 *
 * `effort_inferred` is `auto` resolved *from the prompt* by the effort router rather than from the
 * deployment's declared default. It is a separate value rather than a flag on `effort_preset`
 * because the two answer different questions on replay: a preset resolves the same way forever,
 * while an inferred rung is only reproducible because this event recorded it.
 */
const MODEL_ROUTED_PROFILE_RESOLUTIONS = [
  "effort_preset",
  "effort_inferred",
  "profile_ref",
] as const;

/**
 * Why the effort router chose the rung it chose.
 *
 * This is the calibration record: without the score and the signals behind it, a badly routed turn
 * can be noticed but never explained. `promptHash` stands in for the prompt deliberately — this
 * event is durable, operator-visible evidence, and a routing record carries reasons, never
 * payloads. The hash still groups repeat prompts and ties a complaint about one answer back to the
 * decision that produced it.
 */
const MODEL_ROUTED_EFFORT_INFERENCE_SCHEMA = {
  type: "object",
  required: ["rung", "score", "band", "firedSignals", "usedClassifier", "promptHash"],
  additionalProperties: false,
  properties: {
    rung: { type: "string", enum: [...EFFORT_RUNGS] },
    score: { type: "number" },
    /** `unsure` records that the heuristic did not separate the prompt, so stage 2 was consulted. */
    band: { type: "string", enum: [...EFFORT_RUNGS, "unsure"] },
    firedSignals: { type: "array", items: { type: "string", minLength: 1 } },
    usedClassifier: { type: "boolean" },
    promptHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    classifierLatencyMs: { type: "integer", minimum: 0 },
  },
} as const;

/**
 * Operator evidence for the model routing decision. Selection and denial share one event type so
 * a replay checks one deterministic key for "the model decision for this invocation" regardless of
 * which side of the router it landed on.
 */
const MODEL_ROUTED_SCHEMA = {
  oneOf: [
    {
      type: "object",
      required: [
        "outcome",
        "selector",
        "resolution",
        "profileId",
        "chain",
        "cacheAllowed",
        "rejectedFallbacks",
      ],
      additionalProperties: false,
      properties: {
        outcome: { type: "string", enum: ["selected"] },
        selector: { type: "string", minLength: 1 },
        resolution: { type: "string", enum: [...MODEL_ROUTED_PROFILE_RESOLUTIONS] },
        profileId: { type: "string", minLength: 1 },
        chain: { type: "array", minItems: 1, items: MODEL_ROUTED_CHAIN_ENTRY_SCHEMA },
        cacheAllowed: { type: "boolean" },
        rejectedFallbacks: { type: "array", items: MODEL_ROUTED_ATTEMPT_SCHEMA },
        budgetLimits: MODEL_ROUTED_BUDGET_LIMITS_SCHEMA,
        effortInference: MODEL_ROUTED_EFFORT_INFERENCE_SCHEMA,
      },
    },
    {
      type: "object",
      required: ["outcome", "selector", "resolution", "profileId", "reason", "attempts"],
      additionalProperties: false,
      properties: {
        outcome: { type: "string", enum: ["denied"] },
        selector: { type: "string", minLength: 1 },
        resolution: { type: "string", enum: [...MODEL_ROUTED_PROFILE_RESOLUTIONS] },
        profileId: { type: "string", minLength: 1 },
        reason: { type: "string", enum: MODEL_PROFILE_DENIAL_REASONS },
        attempts: { type: "array", minItems: 1, items: MODEL_ROUTED_ATTEMPT_SCHEMA },
        effortInference: MODEL_ROUTED_EFFORT_INFERENCE_SCHEMA,
      },
    },
    {
      type: "object",
      required: ["outcome", "selector", "resolution", "modelId"],
      additionalProperties: false,
      properties: {
        outcome: { type: "string", enum: ["raw_model"] },
        selector: { type: "string", minLength: 1 },
        resolution: { type: "string", enum: ["raw_model_id"] },
        modelId: { type: "string", minLength: 1 },
      },
    },
  ],
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
  { type: "model.routed", audience: "operator", schema: MODEL_ROUTED_SCHEMA },
  { type: "tool.dispatched", audience: "operator", schema: TOOL_DISPATCHED_SCHEMA },
  { type: "guardrail.decision", audience: "operator", schema: GUARDRAIL_DECISION_SCHEMA },
  { type: "delivery.classified", audience: "operator", schema: DELIVERY_CLASSIFIED_SCHEMA },
];

/** The three points a guardrail can refuse a turn, shared by the block and decision records. */
export type RunEventGuardrailStage = "input" | "tool_call" | "output";

/** Which layer a Tool belongs to. Mirrors the registry's own tiering, not a rendering hint. */
export type RunEventToolTier = "system" | "platform" | "integration";

/** How a selector became a ModelProfile. See {@link MODEL_ROUTED_PROFILE_RESOLUTIONS}. */
export type RunEventModelResolution = (typeof MODEL_ROUTED_PROFILE_RESOLUTIONS)[number];

/**
 * Why the effort router chose the rung it chose, recorded on the `model.routed` event.
 *
 * Present only when `resolution` is `effort_inferred`. It is what makes an inferred rung
 * reproducible: a replayed attempt reads `rung` back from here instead of asking a model again,
 * so a Run routes the same way on its second execution as on its first.
 */
export interface RunEventEffortInference {
  readonly rung: EffortRung;
  readonly score: number;
  /** `unsure` means the heuristic did not separate the prompt and the classifier was consulted. */
  readonly band: EffortRung | "unsure";
  readonly firedSignals: readonly string[];
  readonly usedClassifier: boolean;
  /** SHA-256 of the scored text. The text itself never enters this record. */
  readonly promptHash: string;
  readonly classifierLatencyMs?: number;
}

/**
 * A bounded, redaction-aware view of a Tool's arguments or output.
 *
 * `json` is JSON text, already redacted and already truncated. `redactedPaths` names every leaf
 * that was withheld so a reader shows an explicit gap rather than an absence it cannot explain,
 * and `bytes` is the size of the original value, so "truncated" can say how much is missing.
 */
export interface RunEventToolPreview {
  readonly json: string;
  readonly redactedPaths?: readonly string[];
  readonly truncated?: boolean;
  readonly bytes?: number;
}

export interface ParticipantToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argsDigest?: string;
  readonly argsPreview?: RunEventToolPreview;
  readonly resultPreview?: RunEventToolPreview;
  readonly durationMs?: number;
  readonly outcome?: "ok" | "error";
  readonly errorCode?: string;
}

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
    readonly argsPreview?: RunEventToolPreview;
    readonly tier?: RunEventToolTier;
    readonly mutating?: boolean;
    readonly agentId?: string;
    readonly stepId?: string;
    readonly startedAt?: string;
  };
  readonly "tool.result": {
    readonly callId: string;
    readonly status: "ok" | "error";
    readonly summary?: string;
    readonly errorCode?: string;
    readonly resultPreview?: RunEventToolPreview;
    readonly durationMs?: number;
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
    readonly modelId?: string;
    readonly effortPreset?: EffortPreset;
    readonly effortApplied?: EffortRung;
    readonly modelCallLatencyMs?: number;
    readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  };
  readonly "context.assembled": {
    readonly contextDigest: string;
    readonly guardrailDigest: string;
    readonly messageCount?: number;
    readonly compacted?: boolean;
    readonly modelProfileId?: string;
  };
  readonly "model.routed":
    | {
        readonly outcome: "selected";
        readonly selector: string;
        readonly resolution: RunEventModelResolution;
        readonly profileId: string;
        readonly chain: readonly {
          readonly profileId: string;
          readonly modelId: string;
        }[];
        readonly cacheAllowed: boolean;
        readonly rejectedFallbacks: readonly {
          readonly profileId: string;
          readonly reason: (typeof MODEL_PROFILE_DENIAL_REASONS)[number];
        }[];
        readonly budgetLimits?: {
          readonly tokens?: {
            readonly value: number;
            readonly scope:
              | "deployment"
              | "role"
              | "agent"
              | "routine"
              | "run"
              | "state"
              | "tool"
              | "integration"
              | "model";
          };
          readonly costMicros?: {
            readonly value: number;
            readonly scope:
              | "deployment"
              | "role"
              | "agent"
              | "routine"
              | "run"
              | "state"
              | "tool"
              | "integration"
              | "model";
          };
        };
        readonly effortInference?: RunEventEffortInference;
      }
    | {
        readonly outcome: "denied";
        readonly selector: string;
        readonly resolution: RunEventModelResolution;
        readonly profileId: string;
        readonly reason: (typeof MODEL_PROFILE_DENIAL_REASONS)[number];
        readonly attempts: readonly {
          readonly profileId: string;
          readonly reason: (typeof MODEL_PROFILE_DENIAL_REASONS)[number];
        }[];
        readonly effortInference?: RunEventEffortInference;
      }
    | {
        readonly outcome: "raw_model";
        readonly selector: string;
        readonly resolution: "raw_model_id";
        readonly modelId: string;
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
