import { apiGet, apiWrite } from "./api";

/*
 * Read-only client for persisted chats (UUID-chat persistence). The API auto-creates a conversation
 * on the first turn and fills in a quick-model `title` asynchronously; this client backs the "Recent
 * chats" sidebar list and the `/chat/:id` restore route. Mirrors lib/onboarding.ts conventions
 * (cookie-first auth via apiGet, ApiError on non-2xx).
 */

export type ConversationSummary = {
  id: string;
  title: string | null;
  agentId: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Conversation = ConversationSummary & {
  userId: string | null;
  model: string | null;
};

// Wire shape of a persisted message (mirrors the API's MessageDoc / MessageSchema). `content` is a
// plain string for user/system/summary turns and a parts array for assistant/tool turns.
export type WireMessagePart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown };

export type ConversationMessage = {
  _id: string;
  conversationId: string;
  role: "system" | "user" | "assistant" | "tool" | "summary";
  content: string | WireMessagePart[];
  createdAt: string;
};

// Lists the caller's conversations, newest-first. `q` filters by title (server-side, case-insensitive
// substring, across all the caller's chats); `limit` defaults to 50 server-side (the Chats page passes
// a larger value). A bare `listConversations()` is unchanged for the sidebar.
export async function listConversations(opts?: {
  q?: string;
  limit?: number;
}): Promise<ConversationSummary[]> {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const query = params.toString();
  const body = await apiGet<{ conversations: ConversationSummary[] }>(
    `/api/v1/conversations${query ? `?${query}` : ""}`
  );
  return body.conversations;
}

/** Rename a conversation (owner-only). Returns the updated summary. */
export function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  return apiWrite<ConversationSummary>("PUT", `/api/v1/conversations/${encodeURIComponent(id)}`, {
    title,
  });
}

/** Pin/unpin a conversation (owner-only). Returns the updated summary. */
export function setConversationStarred(id: string, starred: boolean): Promise<ConversationSummary> {
  return apiWrite<ConversationSummary>("PUT", `/api/v1/conversations/${encodeURIComponent(id)}`, {
    starred,
  });
}

export async function getConversation(id: string): Promise<Conversation> {
  return apiGet<Conversation>(`/api/v1/conversations/${encodeURIComponent(id)}`);
}

export async function getConversationMessages(id: string): Promise<ConversationMessage[]> {
  const body = await apiGet<{ messages: ConversationMessage[]; nextCursor: string | null }>(
    `/api/v1/conversations/${encodeURIComponent(id)}/messages`
  );
  return body.messages;
}
