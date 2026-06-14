/*
 * Client for per-message thumbs up/down feedback (FB-V1). Mirrors lib/conversations.ts conventions:
 * cookie-first auth via the shared api.ts helpers, ApiError on non-2xx. The capture layer for a
 * future self-improvement loop — no reads feed any agent yet.
 */

import { apiDelete, apiGet, apiWrite } from "./api";

export type FeedbackRating = "up" | "down";

export type ConversationFeedback = {
  messageId: string;
  rating: FeedbackRating;
  note: string | null;
};

/** Set (or replace) the caller's vote on an assistant message; `note` captures a down-vote reason. */
export function sendFeedback(
  messageId: string,
  rating: FeedbackRating,
  note?: string
): Promise<{ status: string }> {
  return apiWrite<{ status: string }>(
    "POST",
    `/api/v1/messages/${encodeURIComponent(messageId)}/feedback`,
    note ? { rating, note } : { rating }
  );
}

/** Clear the caller's vote on a message (idempotent). */
export function clearFeedback(messageId: string): Promise<void> {
  return apiDelete(`/api/v1/messages/${encodeURIComponent(messageId)}/feedback`);
}

/** The caller's votes across a conversation, to rehydrate the transcript's thumb state on restore. */
export async function getConversationFeedback(
  conversationId: string
): Promise<ConversationFeedback[]> {
  const body = await apiGet<{ feedback: ConversationFeedback[] }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/feedback`
  );
  return body.feedback;
}
