import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

/** The chat row is the shared serialization point for messages and maintenance. */
export async function recordConversationActivity(tx: AuthorizationTransaction, conversationId: string, message = true) {
  if ('commonVersion' in tx && typeof tx.commonVersion === 'number' && tx.commonVersion < 1) {
    if (message)
      await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_conversations')} SET activity_at=clock_timestamp() WHERE id=$1`,
        [conversationId],
      );
    return;
  }
  await tx.client.query(
    `UPDATE ${qualified(tx.schema, 'tf_conversations')}
    SET activity_at=CASE WHEN $2 THEN clock_timestamp() ELSE activity_at END, is_closed=false, activity_generation=activity_generation+1 WHERE id=$1`,
    [conversationId, message],
  );
  await tx.client.query(
    `UPDATE ${qualified(tx.schema, 'tf_conversation_maintenance')}
    SET state='stale', lease_until=NULL, updated_at=clock_timestamp()
    WHERE conversation_id=$1 AND state<>'stale'`,
    [conversationId],
  );
}
