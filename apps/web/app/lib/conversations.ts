import { apiGet } from "./api";

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

export async function listConversations(): Promise<ConversationSummary[]> {
  const body = await apiGet<{ conversations: ConversationSummary[] }>("/api/v1/conversations");
  return body.conversations;
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
