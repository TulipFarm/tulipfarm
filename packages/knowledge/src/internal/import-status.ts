import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

const statusRow = z.object({
  parsing: z.string(),
  embedding: z.string(),
  failure: z.string().nullable(),
  stored: z.string(),
  latest: z.string(),
  latest_failure: z.string().nullable(),
});

export async function importStatus(
  tx: AuthorizationTransaction,
  items: 'slack_items' | 'github_items' | 'atlassian_items',
  document: { source_id: string; native_id: string },
  revisionId: string,
) {
  const row = statusRow.parse(
    (
      await tx.client.query(
        `SELECT w.parsing,w.embedding,w.failure,r.source_revision AS stored,i.source_revision AS latest,i.failure AS latest_failure
    FROM ${qualified(tx.schema, 'tf_knowledge_work')} w
    JOIN ${qualified(tx.schema, 'tf_knowledge_revisions')} r ON r.id=w.revision_id
    JOIN ${qualified(tx.schema, `tf_knowledge_${items}`)} i ON i.source_id=$2 AND i.native_id=$3
    WHERE w.revision_id=$1`,
        [revisionId, document.source_id, document.native_id],
      )
    ).rows[0],
  );
  if (row.latest === row.stored)
    return { parsing: row.parsing, embedding: row.embedding, failure: row.failure, historical: false };
  return {
    parsing: row.latest_failure ? 'failed' : 'queued',
    embedding: 'pending',
    failure: row.latest_failure,
    historical: true,
  };
}
