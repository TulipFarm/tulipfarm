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
  // Webhook-kind integration ingress: raised when an inbound integration event is persisted
  // (ingress worker). Routine event triggers consume it, narrowed via their `filter` expression
  // (e.g. trigger.payload.integration === "slack" && trigger.payload.event === "member_joined_channel").
  INTEGRATION_EVENT: "integration.event",
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
}
