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
    reason: string | null;
    model_failure: { requestId?: string; modelId?: string } | null;
  }>(
    `SELECT t.id, t.run_id, t.status, c.reason, c.model_failure
       FROM conversation_turns t
       LEFT JOIN turn_completions c ON c.turn_id = t.id AND c.attempt = t.attempt
      WHERE t.conversation_id = $1
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 1`,
    [conversationId]
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.model_failure === null ? {} : { modelFailure: row.model_failure }),
  };
}
