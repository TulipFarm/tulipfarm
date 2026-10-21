import type { VectorIndex } from '@tulipfarm/memory-core/ports/vector-index';
import type { MemoryQueryClient } from './query-client.ts';
import { memoryTable, type PostgresMemoryNames } from './names.ts';

export function createPostgresVectorIndex(
  client: MemoryQueryClient,
  names: PostgresMemoryNames,
  eligibility: () => string,
): VectorIndex {
  const table = (name: string) => memoryTable(names, name);
  return {
    eligiblePublications(
      values: [
        membershipId: string,
        userId: string,
        kinds: string[],
        sources: string[],
        documents: string[],
        profileId: string,
      ],
    ) {
      return client.query(
        `SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.access_epoch,e.vector_publication_id
        FROM (${eligibility()}) e JOIN ${table('vector_publications')} p
          ON p.id=e.vector_publication_id AND p.revision_id=e.revision_id AND p.lexical_publication_id=e.publication_id AND p.profile_id=$6`,
        values,
      );
    },
    boundedCount(values: [profileId: string, publications: string[]]) {
      return client.query(
        `SELECT count(*)::int AS count FROM (SELECT 1 FROM ${table('search_vectors')}
        WHERE profile_id=$1 AND vector_publication_id=ANY($2::uuid[]) LIMIT 2049) subset`,
        values,
      );
    },
    configureNearest() {
      return client.query(
        "SELECT set_config('hnsw.iterative_scan','strict_order',true),set_config('hnsw.ef_search','200',true),set_config('hnsw.max_scan_tuples','20000',true)",
      );
    },
    nearest(values: [profileId: string, publications: string[], vector: string, excluded?: string[]], exact: boolean) {
      return client.query(
        exact
          ? `SELECT DISTINCT ON (lexical_publication_id) vector_publication_id,lexical_publication_id,ordinal,embedding OPERATOR(extensions.<=>) $3::extensions.vector(1536) AS distance
            FROM ${table('search_vectors')} WHERE profile_id=$1 AND vector_publication_id=ANY($2::uuid[])
            ORDER BY lexical_publication_id,distance,ordinal`
          : `SELECT vector_publication_id,lexical_publication_id,ordinal,embedding OPERATOR(extensions.<=>) $3::extensions.vector(1536) AS distance
            FROM ${table('search_vectors')} WHERE profile_id=$1 AND vector_publication_id=ANY($2::uuid[]) AND NOT(lexical_publication_id=ANY($4::uuid[]))
            ORDER BY embedding OPERATOR(extensions.<=>) $3::extensions.vector(1536) LIMIT 2000`,
        values,
      );
    },
  };
}
