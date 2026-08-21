import type { ConversationDetail, ConversationTurn } from "@tulipfarm/schema";
import { apiDelete, apiGet, apiWrite } from "./api";

/*
 * Read-only client for persisted chats (UUID-chat persistence). The API auto-creates a
 * conversation on the first turn and fills in a quick-model `title` asynchronously; this client
 * backs the "Recent chats" sidebar list and the `/chat/:id` restore route.
 */

export type ConversationSummary = {
  id: string;
  title: string | null;
  agentId: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Conversation = ConversationSummary & ConversationDetail;
export type { ConversationTurn };

export type WireMessagePart =
  | { type: "text"; text: string }
  | { type: "file"; fileId: string; mediaType: string; name: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown }
  | { type: "surface"; artifactId: string; revision: number }
  | { type: "surface-unavailable"; message: "Legacy presentation unavailable" }
  | { type: "file-unavailable"; fileId: string; name: string };

export type ConversationMessage = {
  _id: string;
  conversationId: string;
  role: "system" | "user" | "assistant" | "tool" | "summary";
  content: string | WireMessagePart[];
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export async function listConversations(opts?: {
  q?: string;
  limit?: number;
}): Promise<ConversationSummary[]> {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const query = params.toString();
  const body = await apiGet<{ conversations: ConversationSummary[] }>(
    `/api/v1/chats${query ? `?${query}` : ""}`
  );
  return body.conversations;
}

export function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  return apiWrite<ConversationSummary>("PUT", `/api/v1/chats/${encodeURIComponent(id)}`, {
    title,
  });
}

export function setConversationStarred(id: string, starred: boolean): Promise<ConversationSummary> {
  return apiWrite<ConversationSummary>("PUT", `/api/v1/chats/${encodeURIComponent(id)}`, {
    starred,
  });
}

export function deleteConversation(id: string): Promise<void> {
  return apiDelete(`/api/v1/chats/${encodeURIComponent(id)}`);
}

export async function getConversation(id: string): Promise<Conversation> {
  return apiGet<Conversation>(`/api/v1/chats/${encodeURIComponent(id)}`);
}

export async function getConversationMessages(id: string): Promise<ConversationMessage[]> {
  const body = await apiGet<{ messages: ConversationMessage[]; nextCursor: string | null }>(
    `/api/v1/chats/${encodeURIComponent(id)}/messages`
  );
  return body.messages;
}

export type DebugContext = {
  conversationId: string;
  systemPrompt: string;
  messages: ConversationMessage[];
};

export function getDebugContext(id: string): Promise<DebugContext> {
  return apiGet<DebugContext>(`/api/v1/chats/${encodeURIComponent(id)}/debug-context`);
}
