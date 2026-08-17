import type { SurfaceInteraction } from "@tulipfarm/surface";

// Neutral in-process domain-event contract (design §3 — EventEmitter bus; LISTEN/NOTIFY
// is future). Emitters (resources routes, chat) and subscribers (knowledge indexing)
// both depend on this module so neither domain depends on the other.

export const DOMAIN_EVENTS = {
  RESOURCE_CREATED: "resource.created",
  RESOURCE_UPDATED: "resource.updated",
  CONVERSATION_CREATED: "conversation.created",
  CONVERSATION_COMPLETED: "conversation.completed",
  // Observability spine (AI metrics). One LLM_STEP_FINISHED per model step; one TURN_FINISHED per
  // chat turn. The observability subscriber turns these into obs_event rows; nothing else listens.
  LLM_STEP_FINISHED: "llm.step_finished",
  TURN_FINISHED: "turn.finished",
  SURFACE_RENDERED: "surface.rendered",
  SURFACE_INTERACTED: "surface.interacted",
  SURFACE_DELIVERED: "surface.delivered",
  // Webhook-kind integration ingress: raised when an inbound integration event is persisted
  // (ingress worker). Routine event triggers consume it, narrowed via their `filter` expression
  // (e.g. trigger.payload.integration === "slack" && trigger.payload.event === "member_joined_channel").
  INTEGRATION_EVENT: "integration.event",
  // The Curator's whole loop reports through this one event: mint outcomes and their skip reasons,
  // settlement effect counts, per-rejection reasons, host denials, crash recovery, and memory
  // document size/compaction. It carries no subject id, because an operator dashboard must never
  // become a way to read who learned what.
  CURATOR_OBSERVED: "curator.observed",
} as const;

export interface ResourceEventPayload {
  resourceType: string;
  resourceId: string;
  record: Record<string, unknown>;
  /** User who triggered the write, when known (API writes). Absent ⇒ recorded as a system actor. */
  actorId?: string;
}

export interface ConversationCreatedPayload {
  conversationId: string;
  actorId?: string;
  agentId?: string;
}

export interface ConversationCompletedPayload {
  conversationId: string;
  actorId?: string;
}

/** One finished model step. `model`/`provider` are already attributed to the served model. */
export interface LlmStepFinishedPayload {
  conversationId: string;
  agentId: string;
  model: string;
  provider: string | null;
  tier?: string;
  tokensIn: number;
  tokensOut: number;
  durationMs?: number;
  status: string;
  /** Prompt-cache + reasoning token breakdown, stashed in obs_event.attributes. */
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  /** USD-per-token cost from the served model's pinned soul spec. When present, the subscriber uses
   *  these for cost (authoritative); otherwise it falls back to the built-in price map. */
  costInPerToken?: number;
  costOutPerToken?: number;
  /** Tools invoked in this step → one tool_call row each. `args`/`result` are stored only when
   *  content capture is enabled (opt-in); otherwise the subscriber drops them. */
  tools?: Array<{
    name: string;
    status: string;
    errorCode?: string;
    args?: unknown;
    result?: unknown;
  }>;
  /** The model's text output this step. Stored only when content capture is enabled. */
  completionText?: string;
}

/** One persisted webhook-kind ingress event (row in integration_events). */
export interface IntegrationEventPayload {
  /** Installation slug of the integration that received the webhook (e.g. "slack"). */
  integration: string;
  /** Verification protocol / provider family ("slack" | "github"). */
  protocol: string;
  /** Provider event type (e.g. "member_joined_channel"). */
  event: string;
  /** integration_events.id of the persisted record. */
  eventId: string;
  /** Raw provider event payload. */
  payload: Record<string, unknown>;
}

/** One completed chat turn, with totals accumulated across its steps (and any handoffs). */
export interface TurnFinishedPayload {
  conversationId: string;
  agentId: string;
  status: string;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  tier?: string;
  durationMs?: number;
  /**
   * The durable Run this turn executed under, when the chat path claimed one. Present with
   * `businessId` or not at all — the subscriber that releases the Run lease needs both.
   */
  runId?: string;
  businessId?: string;
}

export interface SurfaceRenderedPayload {
  conversationId?: string;
  target: string;
  component: string;
  version: string;
  validation: "ok" | "invalid";
  render: "ok" | "failed";
  interaction?: "accepted" | "rejected";
  delivery?: "pending" | "delivered" | "ambiguous" | "failed";
  validationPaths: readonly string[];
  surfaceInteraction?: SurfaceInteraction;
}

/**
 * One report from any point in the Curator loop. Every field is a bounded enum or a number, never
 * a user id, a section body, or a model string, so the whole payload is safe to label a metric
 * with and safe to hand an operator dashboard.
 */
export interface CuratorObservedPayload {
  /** Where in the loop this came from. */
  stage: "mint" | "settle" | "denial" | "recovery" | "document";
  /** Absent only where the loop genuinely does not know it yet — a denial for a job that was
   *  never found has no scope to report. */
  scope?: "user" | "business";
  /** Bounded per stage: `minted`/`skipped`, `settled`, the `CuratorHostDenial` code,
   *  `recovered`/`abandoned`/`swept`, or `written`/`compacted`. */
  outcome: string;
  /** The refusal vocabulary — a `MintSkip`, or a settlement rejection reason such as
   *  `section_changed`, `quote_not_found`, or `governance_hijack`. */
  reason?: string;
  /** How many of `outcome` this reports, for stages that summarise a batch. Defaults to one. */
  count?: number;
  /** Effects the settlement kept, and how many it dropped. Counted, never named. */
  recorded?: number;
  rejected?: number;
  /** Age of the oldest unserved work at sweep time — the loop's real staleness. */
  backlogAgeSeconds?: number;
  /** Size of the memory document after a write, which is what compaction exists to bound. */
  documentBytes?: number;
}
