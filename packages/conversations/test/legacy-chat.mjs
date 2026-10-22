import { randomUUID } from 'node:crypto';

export async function seedLegacyChat({ db, workspace, table }, chatId, text, processing = false) {
  const messageId = randomUUID(),
    turnId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id,next_message_sequence) VALUES ($1,$2,$3,2)`,
    [chatId, workspace.userId, workspace.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id) VALUES ($1,$2,1,'human',$3)`,
    [messageId, chatId, workspace.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_conversation_parts')} (conversation_id,message_id,ordinal,kind,text) VALUES ($1,$2,0,'text',$3)`,
    [chatId, messageId, text],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_conversation_turns')} (id,conversation_id,source_message_id,accepted_sequence,status,attempt_epoch,lease_until) VALUES ($1,$2,$3,1,$4,$5,CASE WHEN $4='processing' THEN clock_timestamp()+interval '60 seconds' ELSE NULL END)`,
    [turnId, chatId, messageId, processing ? 'processing' : 'queued', processing ? 1 : 0],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_conversation_outbox')} (turn_id,conversation_id,generation) VALUES ($1,$2,0)`,
    [turnId, chatId],
  );
  return { messageId, turnId, sequence: 1 };
}
