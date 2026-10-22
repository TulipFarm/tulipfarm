import type { LexicalIndex } from '@tulipfarm/memory-core/ports/lexical-index';
import type { MemoryQueryClient } from './query-client.ts';
import { memoryTable, type PostgresMemoryNames } from './names.ts';

export function createPostgresLexicalIndex(
  client: MemoryQueryClient,
  names: PostgresMemoryNames,
  eligibility: () => string,
): LexicalIndex {
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
        `SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.access_epoch,
          (v.id IS NOT NULL) AS semantic FROM (${eligibility()}) e LEFT JOIN ${table('vector_publications')} v
          ON v.id=e.vector_publication_id AND v.lexical_publication_id=e.publication_id AND v.revision_id=e.revision_id AND v.profile_id=$6`,
        values,
      );
    },
    match(
      values: [query: string, prefix: string, typing: boolean, identifier: string, publications: string[]],
      options: { broaden: boolean; publicationCount: number },
    ) {
      return client.query(
        `WITH q AS (SELECT CASE WHEN $3::boolean THEN to_tsquery('english',$2) ELSE ${
          options.broaden
            ? "(SELECT string_agg(quote_literal(lexeme),' | ')::tsquery FROM unnest(tsvector_to_array(to_tsvector('english',$1))) words(lexeme))"
            : "websearch_to_tsquery('english',$1)"
        } END AS query),
        matches AS (SELECT k.publication_id,k.ordinal,k.identifiers @> ARRAY[$4]::text[] AS exact,ts_rank_cd(k.search_vector,q.query) AS rank
          FROM ${table('chunks')} k CROSS JOIN q
          WHERE (k.search_vector @@ q.query OR k.identifiers @> ARRAY[$4]::text[]) AND k.publication_id=ANY($5::uuid[])),
        best AS (SELECT DISTINCT ON (publication_id) * FROM matches ORDER BY publication_id,exact DESC,rank DESC,ordinal)
        SELECT best.* FROM best${
          options.publicationCount > 200
            ? `
          JOIN ${table('publications')} p ON p.id=best.publication_id
          ORDER BY best.exact DESC,best.rank DESC,p.document_id,best.ordinal LIMIT 200`
            : ''
        }`,
        values,
      );
    },
  };
}
