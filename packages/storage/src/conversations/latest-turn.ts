import type { ConversationTurn } from "@tulipfarm/schema";
import type { Queryable } from "../ports";

export async function findLatestConversationTurn(
  queryable: Queryable,
  conversationId: string
): Promise<ConversationTurn | undefined> {
  const { rows } = await queryable.query<{
    id: string;
    run_id: string | null;
    status: ConversationTurn["status"];
  }>(
    `SELECT id, run_id, status
       FROM conversation_turns
      WHERE conversation_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [conversationId]
  );
  const row = rows[0];
  return row ? { id: row.id, runId: row.run_id, status: row.status } : undefined;
}
