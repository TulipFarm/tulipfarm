// Neutral in-process domain-event contract (design §3 — EventEmitter bus; LISTEN/NOTIFY
// is future). Emitters (resources routes, chat) and subscribers (knowledge indexing)
// both depend on this module so neither domain depends on the other.

export const DOMAIN_EVENTS = {
  RESOURCE_CREATED: "resource.created",
  RESOURCE_UPDATED: "resource.updated",
  CONVERSATION_COMPLETED: "conversation.completed",
} as const;

export interface ResourceEventPayload {
  resourceType: string;
  resourceId: string;
  record: Record<string, unknown>;
}

export interface ConversationCompletedPayload {
  conversationId: string;
}
