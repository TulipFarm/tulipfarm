import type { RetrievalRepository } from '@tulipfarm/memory-core/ports/retrieval-repository';
import type { MemoryQueryClient } from './query-client.ts';
import { memoryTable, type PostgresMemoryNames } from './names.ts';
export function createPostgresRetrievalRepository(
  client: MemoryQueryClient,
  names: PostgresMemoryNames,
): RetrievalRepository {
  const table = (name: string) => memoryTable(names, name);
  return {
    anchors: values =>
      client.query(
        `SELECT p.id AS publication_id,p.document_id,p.revision_id,d.source_id,s.access_epoch,a.ordinal,
           p.created_at AS indexed_at,r.created_at AS observed_at,s.synced_at,
           CASE WHEN s.provider IN ('google','slack','github','confluence','jira') THEN left(r.source_revision,200) END AS source_revision
         FROM unnest($1::uuid[],$2::int[]) WITH ORDINALITY a(publication_id,ordinal,position)
         JOIN ${table('publications')} p ON p.id=a.publication_id
         JOIN ${table('revisions')} r ON r.id=p.revision_id
         JOIN ${table('documents')} d ON d.id=p.document_id
         JOIN ${table('sources')} s ON s.id=d.source_id
         JOIN ${table('chunks')} k ON k.publication_id=p.id AND k.ordinal=a.ordinal
         WHERE s.provider=ANY($3::text[]) AND (cardinality($4::uuid[])=0 OR s.id=ANY($4::uuid[]))
           AND (cardinality($5::uuid[])=0 OR d.id=ANY($5::uuid[]))
         ORDER BY a.position`,
        values,
      ),
    passages: values =>
      client.query(
        `WITH ranked AS (
          SELECT k.publication_id,k.ordinal,k.heading,k.passage,
            count(*) OVER (PARTITION BY k.publication_id)::int AS chunk_count,
            row_number() OVER (PARTITION BY k.publication_id ORDER BY
              min(CASE WHEN k.ordinal=a.ordinal THEN 0 WHEN k.heading=anchor.heading THEN 1 ELSE 2 END),
              min(abs(k.ordinal-a.ordinal)),k.ordinal) AS priority
          FROM unnest($1::uuid[],$2::int[]) a(publication_id,ordinal)
          JOIN ${table('chunks')} anchor ON anchor.publication_id=a.publication_id AND anchor.ordinal=a.ordinal
          JOIN ${table('chunks')} k ON k.publication_id=a.publication_id
          GROUP BY k.publication_id,k.ordinal,k.heading,k.passage
        ), budgeted AS (
          SELECT *,row_number() OVER (PARTITION BY publication_id ORDER BY priority) AS selected_priority,
            COALESCE(sum(length(passage)) OVER
            (PARTITION BY publication_id ORDER BY priority ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::int AS preceding
          FROM ranked
          WHERE NOT (publication_id::text || ':' || ordinal::text = ANY($5::text[]))
        )
        SELECT publication_id,ordinal,heading,left(passage,$3-preceding) AS text,
          length(passage)>$3-preceding AS truncated,chunk_count
        FROM budgeted WHERE preceding<$3 AND selected_priority<=$4
        ORDER BY publication_id,priority`,
        values,
      ),
  };
}
