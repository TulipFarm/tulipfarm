import { readableFileSql } from '@tulipfarm/files';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

export function searchEligibility(
  schema: string,
  google = false,
  slack = false,
  github = false,
  atlassian = false,
  conversation = false,
) {
  const table = (name: string) => qualified(schema, `tf_knowledge_${name}`);
  return `SELECT d.id AS document_id,d.source_id,d.observed_revision_id AS revision_id,
    d.lexical_publication_id AS publication_id,d.vector_publication_id,s.access_epoch,NULL::timestamptz AS expires_at
    FROM ${table('documents')} d
    JOIN ${table('sources')} s ON s.id=d.source_id
    JOIN ${table('revisions')} r ON r.id=d.observed_revision_id AND r.document_id=d.id
    JOIN ${table('local_revisions')} l ON l.revision_id=r.id
    JOIN ${table('publications')} p ON p.id=d.lexical_publication_id AND p.revision_id=r.id
    WHERE s.owner_membership_id=$1 AND l.owner_membership_id=$1 AND l.owner_user_id=$2
      AND s.state IN ('active','paused') AND d.tombstoned_at IS NULL AND r.sources='[]'::jsonb
      AND s.provider=ANY($3::text[])
      AND (cardinality($4::uuid[])=0 OR s.id=ANY($4::uuid[]))
      AND (cardinality($5::uuid[])=0 OR d.id=ANY($5::uuid[]))
      AND ((s.provider='note' AND r.original->>'kind'='object' AND r.original->>'key'=r.id::text)
        OR (s.provider='file' AND r.original->>'kind'='file' AND ${readableFileSql(schema)}))${
          google
            ? `
    UNION ALL SELECT d.id,d.source_id,d.observed_revision_id,d.lexical_publication_id,d.vector_publication_id,s.access_epoch,e.expires_at
    FROM ${table('google_eligible')} e JOIN ${table('documents')} d ON d.id=e.document_id
    JOIN ${table('sources')} s ON s.id=d.source_id
    JOIN ${table('revisions')} r ON r.id=d.observed_revision_id AND r.document_id=d.id
    JOIN ${table('google_originals')} g ON g.revision_id=r.id
    JOIN ${table('publications')} p ON p.id=d.lexical_publication_id AND p.revision_id=r.id
    WHERE e.membership_id=$1 AND e.user_id=$2 AND r.sources='[]'::jsonb
      AND r.original->>'kind'='object' AND r.original->>'key'=r.id::text
      AND s.provider=ANY($3::text[])
      AND (cardinality($4::uuid[])=0 OR s.id=ANY($4::uuid[]))
      AND (cardinality($5::uuid[])=0 OR d.id=ANY($5::uuid[]))`
            : ''
        }${
          slack
            ? `
    UNION ALL SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.vector_publication_id,e.access_epoch,e.expires_at
    FROM ${table('slack_eligible_for')}($1::uuid,$2::text) e
    JOIN ${table('publications')} p ON p.id=e.publication_id AND p.revision_id=e.revision_id
    WHERE true
      AND e.provider=ANY($3::text[])
      AND (cardinality($4::uuid[])=0 OR e.source_id=ANY($4::uuid[]))
      AND (cardinality($5::uuid[])=0 OR e.document_id=ANY($5::uuid[]))`
            : ''
        }${
          github
            ? `
    UNION ALL SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.vector_publication_id,e.access_epoch,e.expires_at
    FROM ${table('github_eligible_for')}($1::uuid,$2::text) e
    JOIN ${table('publications')} p ON p.id=e.publication_id AND p.revision_id=e.revision_id
    WHERE true
      AND e.provider=ANY($3::text[])
      AND (cardinality($4::uuid[])=0 OR e.source_id=ANY($4::uuid[]))
      AND (cardinality($5::uuid[])=0 OR e.document_id=ANY($5::uuid[]))`
            : ''
        }${
          atlassian
            ? `
    UNION ALL SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.vector_publication_id,e.access_epoch,e.expires_at
    FROM ${table('atlassian_eligible_for')}($1::uuid,$2::text) e
    JOIN ${table('publications')} p ON p.id=e.publication_id AND p.revision_id=e.revision_id
    WHERE true
      AND e.provider=ANY($3::text[])
      AND (cardinality($4::uuid[])=0 OR e.source_id=ANY($4::uuid[]))
      AND (cardinality($5::uuid[])=0 OR e.document_id=ANY($5::uuid[]))`
            : ''
        }${
          conversation
            ? `
    UNION ALL SELECT d.id,d.source_id,d.observed_revision_id,d.lexical_publication_id,d.vector_publication_id,s.access_epoch,NULL::timestamptz
    FROM ${table('conversation_readers')} e
    JOIN ${table('sources')} s ON s.id=e.source_id
    JOIN ${table('documents')} d ON d.source_id=s.id AND d.native_id=e.conversation_id::text AND d.tombstoned_at IS NULL
    JOIN ${table('conversation_revisions')} r ON r.revision_id=d.observed_revision_id AND r.conversation_id=e.conversation_id
    JOIN ${qualified(schema, 'tf_conversations')} c ON c.id=r.conversation_id AND c.is_closed AND c.activity_generation=r.generation AND c.deleted_at IS NULL
    JOIN ${table('publications')} p ON p.id=d.lexical_publication_id AND p.revision_id=r.revision_id
    WHERE e.membership_id=$1 AND e.user_id=$2 AND s.provider=ANY($3::text[])
      AND NOT EXISTS (SELECT 1 FROM ${qualified(schema, 'tf_conversation_turns')} t WHERE t.conversation_id=c.id AND t.status IN ('queued','processing','waiting','reconciling'))
      AND (cardinality($4::uuid[])=0 OR s.id=ANY($4::uuid[]))
      AND (cardinality($5::uuid[])=0 OR d.id=ANY($5::uuid[]))`
            : ''
        }`;
}
