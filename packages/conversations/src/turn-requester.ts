import { AccessDenied, humanActorSchema, type HumanActor, type AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

export async function turnRequester(
  tx: AuthorizationTransaction,
  conversationId: string,
  turnId: string,
): Promise<Readonly<HumanActor>> {
  const row = (
    await tx.client.query(
      `SELECT 'human' AS kind, member.user_id AS "userId", member.id AS "membershipId"
    FROM ${qualified(tx.schema, 'tf_conversation_turns')} t
    JOIN ${qualified(tx.schema, 'tf_conversation_messages')} m ON m.conversation_id = t.conversation_id AND m.id = t.source_message_id AND m.sequence = t.accepted_sequence
    JOIN ${qualified(tx.schema, 'tf_memberships')} member ON member.id = m.membership_id
    WHERE t.id = $1 AND t.conversation_id = $2 AND m.author_kind = 'human' AND member.removed_at IS NULL`,
      [turnId, conversationId],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  return humanActorSchema.parse(row);
}
