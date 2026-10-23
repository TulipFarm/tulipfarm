import type { SearchSessions } from '@tulipfarm/memory-core/ports/search-sessions';
import type { MemoryQueryClient } from './query-client.ts';
import { memoryTable, type PostgresMemoryNames } from './names.ts';
import { readCoverageGaps } from './coverage-gaps.ts';

export function createPostgresSearchSessions(
  client: MemoryQueryClient,
  names: PostgresMemoryNames,
  eligibility: () => string,
): SearchSessions {
  const table = (name: string) => memoryTable(names, name);
  return {
    readLive(values: [id: string, membershipId: string, userId: string]) {
      return client.query(
        `SELECT * FROM ${table('search_sessions')} WHERE id=$1 AND owner_membership_id=$2 AND owner_user_id=$3 AND expires_at>clock_timestamp()`,
        values,
      );
    },
    lockOwner(values: [membershipId: string]) {
      return client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('${table('search_sessions').replaceAll("'", "''")}:' || $1, 0))`,
        values,
      );
    },
    pruneExpired() {
      return client.query(
        `DELETE FROM ${table('search_sessions')} WHERE id IN (SELECT id FROM ${table('search_sessions')} WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100)`,
      );
    },
    countOwned(values: [membershipId: string]) {
      return client.query(
        `SELECT count(*)::int AS count FROM ${table('search_sessions')} WHERE owner_membership_id=$1`,
        values,
      );
    },
    evictOldest(values: [membershipId: string]) {
      return client.query(
        `DELETE FROM ${table('search_sessions')} WHERE (id,owner_membership_id) IN
          (SELECT id,owner_membership_id FROM ${table('search_sessions')} WHERE owner_membership_id=$1 ORDER BY expires_at,id LIMIT 1)`,
        values,
      );
    },
    insert(
      values: [
        id: string,
        membershipId: string,
        userId: string,
        fingerprint: string,
        filters: unknown,
        candidates: string,
        mode: string,
        reason: string | null,
        coverage: string,
        expiresAt: Date,
      ],
    ) {
      return client.query(
        `INSERT INTO ${table('search_sessions')} (id,owner_membership_id,owner_user_id,fingerprint,filters,candidates,mode,reason,coverage,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        values,
      );
    },
    readOwned(values: [id: string, membershipId: string, userId: string]) {
      return client.query(
        `SELECT * FROM ${table('search_sessions')} WHERE id=$1 AND owner_membership_id=$2 AND owner_user_id=$3`,
        values,
      );
    },
    readPage(
      values: [
        membershipId: string,
        userId: string,
        kinds: string[],
        sources: string[],
        documents: string[],
        candidates: string,
        offset: number,
        profileId: string,
        remainingDocuments: string[],
      ],
    ) {
      return client.query(
        `WITH eligible AS MATERIALIZED (
          SELECT e.* FROM (${eligibility()}) e WHERE e.document_id=ANY($9::uuid[])),
        candidates AS (SELECT c.*, (a.ordinality-1)::int AS position FROM jsonb_array_elements($6::jsonb) WITH ORDINALITY a(value,ordinality)
          CROSS JOIN LATERAL jsonb_to_record(a.value) AS c(document_id uuid,source_id uuid,revision_id uuid,publication_id uuid,access_epoch int,ordinal int,vector_publication_id uuid,exact boolean))
        SELECT c.*,e.expires_at,k.search_title AS title,k.heading,left(k.passage,2400) AS passage,k.source_offset,
          CASE WHEN r.original->>'kind'='file' THEN (r.original->>'fileId')::uuid END AS file_id,
          p.created_at AS indexed_at,r.created_at AS observed_at,s.synced_at,
          CASE WHEN s.provider IN ('google','slack','github','confluence','jira') THEN left(r.source_revision,200) END AS source_revision
          FROM candidates c
          JOIN eligible e ON e.document_id=c.document_id AND e.source_id=c.source_id AND e.revision_id=c.revision_id
            AND e.publication_id=c.publication_id AND e.access_epoch=c.access_epoch
          JOIN ${table('revisions')} r ON r.id=c.revision_id
          JOIN ${table('publications')} p ON p.id=c.publication_id
          JOIN ${table('sources')} s ON s.id=c.source_id
          JOIN ${table('chunks')} k ON k.publication_id=c.publication_id AND k.ordinal=c.ordinal
          WHERE c.position >= $7 AND (c.vector_publication_id IS NULL OR (e.vector_publication_id=c.vector_publication_id AND EXISTS (
            SELECT 1 FROM ${table('vector_publications')} p WHERE p.id=c.vector_publication_id AND p.lexical_publication_id=c.publication_id
              AND p.revision_id=c.revision_id AND p.profile_id=$8))) ORDER BY c.position LIMIT 20`,
        values,
      );
    },
    readGaps: values => readCoverageGaps(client, table('coverage_gaps'), values),
  };
}
