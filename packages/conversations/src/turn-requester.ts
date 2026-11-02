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

/**
 * A fired chat follow-up runs on its saved instruction alone: no earlier turn of its chat is in its context, so the
 * checks that guard earlier private turns treat it like a chat's first turn. Its source message id is the follow-up id.
 */
export async function standaloneTurn(
  tx: AuthorizationTransaction,
  conversationId: string,
  turnId: string,
): Promise<boolean> {
  const followUps = qualified(tx.schema, 'tf_follow_ups');
  if (
    !(
      await tx.client.query(
        `SELECT CASE WHEN to_regclass($1) IS NULL THEN false ELSE has_table_privilege($1, 'SELECT') END AS readable`,
        [followUps],
      )
    ).rows[0]?.readable
  )
    return false;
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_turns')} t
    JOIN ${followUps} f ON f.id = t.source_message_id AND f.conversation_id = t.conversation_id
    WHERE t.id = $1 AND t.conversation_id = $2`,
        [turnId, conversationId],
      )
    ).rowCount,
  );
}
