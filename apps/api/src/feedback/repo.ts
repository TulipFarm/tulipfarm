import type { Queryable } from "../db";

export type FeedbackRating = "up" | "down";

export interface FeedbackRow {
  messageId: string;
  rating: FeedbackRating;
  note: string | null;
}

export const ratingToInt = (r: FeedbackRating): number => (r === "up" ? 1 : -1);
const intToRating = (n: number): FeedbackRating => (n === 1 ? "up" : "down");

/**
 * Per-message thumbs up/down feedback (FB-V1). SELECT FROM messages`) so a vote on a missing
 * message inserts nothing — the route maps that to 404.
 */
export class FeedbackRepo {
  constructor(private readonly db: Queryable) {}

  /**
   * Set/replace the caller's vote on a message. Returns false when the message does not exist (the
   * `SELECT FROM messages` yields no row, so nothing is inserted), which the route surfaces as 404.
   */
  async upsert(input: {
    id: string;
    messageId: string;
    userId: string;
    rating: FeedbackRating;
    note: string | null;
  }): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO message_feedback
         (id, message_id, conversation_id, user_id, rating, note, created_at, updated_at)
       SELECT $1, m.id, m.conversation_id, $3, $4, $5, now(), now()
       FROM messages m WHERE m.id = $2
       ON CONFLICT (message_id, user_id)
       DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note, updated_at = now()
       RETURNING message_id`,
      [input.id, input.messageId, input.userId, ratingToInt(input.rating), input.note]
    );
    return rows.length > 0;
  }

  /** Remove the caller's vote on a message (idempotent — no-op if absent). */
  async clear(messageId: string, userId: string): Promise<void> {
    await this.db.query(`DELETE FROM message_feedback WHERE message_id = $1 AND user_id = $2`, [
      messageId,
      userId,
    ]);
  }

  async listByConversation(conversationId: string, userId: string): Promise<FeedbackRow[]> {
    const { rows } = await this.db.query(
      `SELECT message_id, rating, note FROM message_feedback
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );
    return rows.map((r) => ({
      messageId: r.message_id as string,
      rating: intToRating(r.rating as number),
      note: (r.note as string | null) ?? null,
    }));
  }
}
