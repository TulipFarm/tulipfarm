import { randomUUID } from 'node:crypto';
import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { notifyConversationChange } from './event-publisher.ts';

const unavailableReviewMessage =
  'The review request could not be opened, so I closed it. No pending change was approved. Send a new message to continue.';

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

export async function finishUnavailableReview(
  tx: AuthorizationTransaction,
  work: { workspaceId: string; conversationId: string; turnId: string },
) {
  const table = (name: string) => qualified(tx.schema, name);
  const messageId = randomUUID();
  const waiting = await tx.client.query(
    `SELECT id FROM ${table('tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND status='waiting' AND response_message_id IS NULL FOR UPDATE`,
    [work.turnId, work.conversationId],
  );
  if (!waiting.rowCount) return;
  await tx.client.query(
    `INSERT INTO ${table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind)
        SELECT $1,id,next_message_sequence,'assistant' FROM ${table('tf_conversations')} WHERE id=$2`,
    [messageId, work.conversationId],
  );
  await tx.client.query(
    `INSERT INTO ${table('tf_conversation_parts')} (conversation_id,message_id,ordinal,kind,text) VALUES ($1,$2,0,'text',$3)`,
    [work.conversationId, messageId, unavailableReviewMessage],
  );
  await tx.client.query(
    `INSERT INTO ${table('tf_conversation_results')} (conversation_id,turn_id,message_id,sources) VALUES ($1,$2,$3,'[]')`,
    [work.conversationId, work.turnId, messageId],
  );
  await tx.client.query(
    `UPDATE ${table('tf_conversation_turns')} SET status='completed',response_message_id=$2,generation=generation+1,attempt_epoch=attempt_epoch+1,lease_until=NULL,retry_at=NULL,error_code=NULL WHERE id=$1`,
    [work.turnId, messageId],
  );
  await tx.client.query(
    `UPDATE ${table('tf_conversation_requests')} SET status='expired' WHERE turn_id=$1 AND status='pending'`,
    [work.turnId],
  );
  await tx.client.query(
    `UPDATE ${table('tf_conversations')} SET next_message_sequence=next_message_sequence+1 WHERE id=$1`,
    [work.conversationId],
  );
  await recordConversationActivity(tx, work.conversationId);
  await notifyConversationChange(tx, { ...work, settled: true });
}

/** Records a system failure, never a member's approval or dismissal. */
export async function closeUnavailableDraft(
  tx: AuthorizationTransaction,
  work: { workspaceId: string; conversationId: string; turnId: string },
  actor: HumanActor,
  draftId: string,
) {
  await tx.client.query(`SELECT id FROM ${qualified(tx.schema, 'tf_conversations')} WHERE id=$1 FOR UPDATE`, [
    work.conversationId,
  ]);
  const saved = await tx.client.query(
    `INSERT INTO ${qualified(tx.schema, 'tf_chat_authoring_decisions')} (draft_id,membership_id,command_id,input,outcome)
        SELECT id,membership_id,$2,'{"reason":"sources-unavailable"}','{"kind":"unavailable"}' FROM ${qualified(tx.schema, 'tf_chat_authoring_drafts')}
        WHERE id=$1 AND conversation_id=$3 AND membership_id=$4 AND user_id=$5 AND turn_id=$6 ON CONFLICT (draft_id) DO NOTHING RETURNING draft_id`,
    [draftId, randomUUID(), work.conversationId, actor.membershipId, actor.userId, work.turnId],
  );
  if (!saved.rowCount) return;
  await finishUnavailableReview(tx, work);
  await tx.client.query(
    `INSERT INTO ${qualified(tx.schema, 'tf_conversation_parts')} (conversation_id,message_id,ordinal,kind,text)
        SELECT t.conversation_id,t.response_message_id,COALESCE((SELECT max(p.ordinal)+1 FROM ${qualified(tx.schema, 'tf_conversation_parts')} p WHERE p.message_id=t.response_message_id),0),'text',$2
        FROM ${qualified(tx.schema, 'tf_conversation_turns')} t WHERE t.id=$1 AND t.status='completed'
          AND NOT EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_parts')} p WHERE p.message_id=t.response_message_id AND p.kind='text' AND p.text=$2)`,
    [work.turnId, unavailableReviewMessage],
  );
  await recordConversationActivity(tx, work.conversationId);
  await notifyConversationChange(tx, { ...work, settled: true });
}
