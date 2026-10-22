import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { KnowledgeEligibilitySelection } from './eligibility.ts';

type Transaction = AuthorizationTransaction & { commonVersion: number };
const table = (tx: Transaction, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);

export async function embeddingDiscoveryCandidate(
  tx: Transaction,
  profileId: string,
  documentId: string | undefined,
  { google, slack, github, atlassian }: KnowledgeEligibilitySelection,
) {
  return (
    await tx.client.query(
      `SELECT d.id AS document_id,d.observed_revision_id AS revision_id,d.lexical_publication_id AS publication_id,
      m.id AS owner_membership_id,m.user_id AS owner_user_id,s.access_epoch,p.chunk_count
      FROM ${table(tx, 'documents')} d JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
      JOIN ${table(tx, 'publications')} p ON p.id=d.lexical_publication_id AND p.revision_id=d.observed_revision_id
      ${
        tx.commonVersion >= 1
          ? `LEFT JOIN ${table(tx, 'conversation_revisions')} cr ON cr.revision_id=d.observed_revision_id
        LEFT JOIN ${qualified(tx.schema, 'tf_conversation_maintenance')} cm ON cm.conversation_id=cr.conversation_id AND cm.generation=cr.generation`
          : ''
      }
      JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=${tx.commonVersion >= 1 ? 'COALESCE(cm.requester_membership_id,s.owner_membership_id)' : 's.owner_membership_id'}
      WHERE d.tombstoned_at IS NULL AND s.state='active' AND (s.provider IN ('note','file')${tx.commonVersion >= 1 ? ` OR (s.provider='conversation' AND EXISTS (SELECT 1 FROM ${table(tx, 'conversation_readers')} e JOIN ${qualified(tx.schema, 'tf_conversations')} c ON c.id=e.conversation_id WHERE e.source_id=s.id AND e.conversation_id=cr.conversation_id AND d.native_id=c.id::text AND e.membership_id=m.id AND c.is_closed AND c.activity_generation=cr.generation))` : ''}${google ? ` OR (s.provider='google' AND EXISTS (SELECT 1 FROM ${table(tx, 'google_eligible')} e WHERE e.document_id=d.id AND e.membership_id=m.id))` : ''}${slack ? ` OR (s.provider='slack' AND EXISTS (SELECT 1 FROM ${table(tx, 'slack_eligible')} e WHERE e.document_id=d.id AND e.membership_id=m.id))` : ''}${github ? ` OR (s.provider='github' AND EXISTS (SELECT 1 FROM ${table(tx, 'github_eligible')} e WHERE e.document_id=d.id AND e.membership_id=m.id))` : ''}${atlassian ? ` OR (s.provider IN ('confluence','jira') AND EXISTS (SELECT 1 FROM ${table(tx, 'atlassian_eligible')} e WHERE e.document_id=d.id AND e.membership_id=m.id))` : ''}) AND m.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'embedding_jobs')} j WHERE j.publication_id=p.id AND j.profile_id=$1)
      AND ($2::uuid IS NULL OR d.id=$2)
      ORDER BY p.created_at,p.id LIMIT 1`,
      [profileId, documentId ?? null],
    )
  ).rows[0];
}

export async function changedConversationEmbeddingOwners(tx: Transaction) {
  return (
    await tx.client.query(
      `SELECT to_jsonb(j) AS job,m.requester_membership_id AS membership_id,m.requester_user_id AS user_id
            FROM ${table(tx, 'embedding_jobs')} j
            JOIN ${table(tx, 'conversation_revisions')} r ON r.revision_id=j.revision_id
            JOIN ${qualified(tx.schema, 'tf_conversation_maintenance')} m ON m.conversation_id=r.conversation_id AND m.generation=r.generation
            WHERE j.purpose='ingestion' AND j.state<>'busy' AND m.state IN ('publishing','ready')
              AND (j.owner_membership_id<>m.requester_membership_id OR j.owner_user_id<>m.requester_user_id)
            ORDER BY j.id LIMIT 100 FOR UPDATE OF j`,
    )
  ).rows;
}
