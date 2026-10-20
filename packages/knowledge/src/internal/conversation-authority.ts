import { AccessDenied, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

export async function requireConversationReader(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  sourceId: string,
  conversationId?: string,
) {
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${qualified(tx.schema, 'tf_knowledge_conversation_readers')}
    WHERE source_id=$1 AND membership_id=$2 AND user_id=$3 AND ($4::uuid IS NULL OR conversation_id=$4)`,
        [sourceId, actor.membershipId, actor.userId, conversationId ?? null],
      )
    ).rowCount
  )
    throw new AccessDenied();
}

export async function requireConversationRevision(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  revisionId: string,
  writing = false,
) {
  // The chat lock serializes final evidence checks with reopening and deletion.
  if (
    !(
      await tx.client.query(
        `SELECT c.id FROM ${qualified(tx.schema, 'tf_knowledge_conversation_revisions')} r
    JOIN ${qualified(tx.schema, 'tf_conversations')} c ON c.id=r.conversation_id
    JOIN ${qualified(tx.schema, 'tf_knowledge_revisions')} kr ON kr.id=r.revision_id
    JOIN ${qualified(tx.schema, 'tf_knowledge_documents')} d ON d.id=kr.document_id AND d.native_id=c.id::text
    JOIN ${qualified(tx.schema, 'tf_knowledge_conversation_readers')} reader ON reader.source_id=d.source_id AND reader.conversation_id=c.id
    JOIN ${qualified(tx.schema, 'tf_conversation_messages')} m ON m.id=r.coverage_message_id AND m.conversation_id=c.id
    WHERE r.revision_id=$1 AND reader.membership_id=$2 AND reader.user_id=$3
      AND c.is_closed AND c.activity_generation=r.generation AND c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_turns')} t
        WHERE t.conversation_id=c.id AND t.status IN ('queued','processing','waiting','reconciling'))
      ${
        writing
          ? `AND EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_maintenance')} j
        WHERE j.conversation_id=c.id AND j.generation=r.generation AND j.state IN ('publishing','ready')
          AND j.requester_membership_id=$2 AND j.requester_user_id=$3
          AND ((j.resume_command_id IS NULL AND $2=(SELECT latest.membership_id
            FROM ${qualified(tx.schema, 'tf_conversation_messages')} latest
            WHERE latest.conversation_id=c.id AND latest.author_kind='human' ORDER BY latest.sequence DESC LIMIT 1))
          OR EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_maintenance_commands')} command
            WHERE command.conversation_id=c.id AND command.membership_id=$2 AND command.command_id=j.resume_command_id)))`
          : ''
      }
    FOR SHARE OF c`,
        [revisionId, actor.membershipId, actor.userId],
      )
    ).rowCount
  )
    throw new AccessDenied();
}
