import type { KnowledgeRepository } from '@tulipfarm/memory-core/ports/knowledge-repository';
import type { MemoryQueryClient } from './query-client.ts';
import { memoryTable, type PostgresMemoryNames } from './names.ts';

export function createPostgresKnowledgeRepository(
  client: MemoryQueryClient,
  names: PostgresMemoryNames,
): KnowledgeRepository {
  const table = (name: string) => memoryTable(names, name);
  return {
    readSource(values: [id: string]) {
      return client.query(`SELECT * FROM ${table('sources')} WHERE id=$1`, values);
    },
    readDocument(values: [id: string]) {
      return client.query(`SELECT * FROM ${table('documents')} WHERE id=$1`, values);
    },
    readDocumentRevision(values: [revisionId: string, documentId: string]) {
      return client.query(`SELECT * FROM ${table('revisions')} WHERE id=$1 AND document_id=$2`, values);
    },
    countSources() {
      return client.query(`SELECT count(*)::int AS count FROM ${table('sources')}`);
    },
    insertSource(values: [id: string, provider: string, namespace: string, selection: string, owner: string]) {
      return client.query(
        `INSERT INTO ${table('sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,$2,$3,$4,$5)`,
        values,
      );
    },
    readRevision(values: [id: string]) {
      return client.query(`SELECT * FROM ${table('revisions')} WHERE id=$1`, values);
    },
    documentUsage(values: [documentId: string]) {
      return client.query(
        `SELECT
        (SELECT count(*)::int FROM ${table('documents')}) AS documents,
        (SELECT count(*)::int FROM ${table('revisions')} WHERE document_id=$1) AS revisions,
        (SELECT COALESCE(sum(original_bytes),0) FROM ${table('revisions')}) +
        (SELECT COALESCE(sum(octet_length(normalized_content)),0) FROM ${table('google_originals')}) +
        (SELECT COALESCE(sum(octet_length(markdown)),0) FROM ${table('publications')}) +
        (SELECT COALESCE(sum(octet_length(passage)+octet_length(heading)),0) FROM ${table('chunks')}) AS bytes`,
        values,
      );
    },
    insertDocument(values: [id: string, sourceId: string, nativeId: string]) {
      return client.query(`INSERT INTO ${table('documents')} (id,source_id,native_id) VALUES ($1,$2,$3)`, values);
    },
    insertRevision(
      values: [
        id: string,
        documentId: string,
        sourceRevision: string,
        title: string,
        canonicalUrl: string | null,
        original: unknown,
        bytes: number,
        parser: unknown,
        sources: string,
        fingerprint: string,
      ],
    ) {
      return client.query(
        `INSERT INTO ${table('revisions')} (id,document_id,source_revision,title,canonical_url,original,original_bytes,parser_profile,sources,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        values,
      );
    },
    insertWork(values: [revisionId: string]) {
      return client.query(`INSERT INTO ${table('work')} (revision_id) VALUES ($1)`, values);
    },
    observeDocument(values: [documentId: string, revisionId: string]) {
      return client.query(
        `UPDATE ${table('documents')} SET observed_revision_id=$2,lexical_publication_id=NULL,vector_publication_id=NULL WHERE id=$1`,
        values,
      );
    },
    readParsing(values: [revisionId: string]) {
      return client.query(`SELECT parsing FROM ${table('work')} WHERE revision_id=$1`, values);
    },
    publicationFingerprint(values: [id: string]) {
      return client.query(`SELECT fingerprint FROM ${table('publications')} WHERE id=$1`, values);
    },
    publicationUsage(values: [revisionId: string]) {
      return client.query(
        `SELECT
          (SELECT count(*)::int FROM ${table('publications')} WHERE revision_id=$1) AS publications,
          (SELECT count(*)::int FROM ${table('chunks')}) AS chunks,
          (SELECT COALESCE(sum(original_bytes),0) FROM ${table('revisions')}) +
          (SELECT COALESCE(sum(octet_length(normalized_content)),0) FROM ${table('google_originals')}) +
          (SELECT COALESCE(sum(octet_length(markdown)),0) FROM ${table('publications')}) +
          (SELECT COALESCE(sum(octet_length(passage)+octet_length(heading)),0) FROM ${table('chunks')}) AS bytes`,
        values,
      );
    },
    insertPublication(
      values: [
        id: string,
        documentId: string,
        revisionId: string,
        markdown: string,
        pages: number,
        tokens: number,
        chunks: number,
        fingerprint: string,
      ],
    ) {
      return client.query(
        `INSERT INTO ${table('publications')} (id,document_id,revision_id,markdown,pages,tokens,chunk_count,fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        values,
      );
    },
    insertSearchChunk(
      values: [
        publicationId: string,
        ordinal: number,
        heading: string,
        passage: string,
        tokens: number,
        offset: unknown,
        hash: string,
        title: string,
        identifiers: string[],
      ],
    ) {
      return client.query(
        `INSERT INTO ${table('chunks')} (publication_id,ordinal,heading,passage,tokens,source_offset,input_hash,search_title,identifiers) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values,
      );
    },
    insertChunk(
      values: [
        publicationId: string,
        ordinal: number,
        heading: string,
        passage: string,
        tokens: number,
        offset: unknown,
        hash: string,
      ],
    ) {
      return client.query(
        `INSERT INTO ${table('chunks')} (publication_id,ordinal,heading,passage,tokens,source_offset,input_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values,
      );
    },
    publishDocument(values: [documentId: string, publicationId: string]) {
      return client.query(
        `UPDATE ${table('documents')} SET lexical_publication_id=$2,vector_publication_id=CASE WHEN lexical_publication_id=$2 THEN vector_publication_id ELSE NULL END WHERE id=$1`,
        values,
      );
    },
    completeParsing(values: [revisionId: string]) {
      return client.query(`UPDATE ${table('work')} SET parsing='ready',failure=NULL WHERE revision_id=$1`, values);
    },
    invalidateAccessEpoch(values: [sourceId: string, epoch: number]) {
      return client.query(
        `UPDATE ${table('sources')} SET access_epoch=access_epoch+1 WHERE id=$1 AND access_epoch=$2`,
        values,
      );
    },
    currentTime() {
      return client.query('SELECT clock_timestamp() AS now');
    },
    recordProof(
      values: [
        id: string,
        documentId: string,
        membershipId: string,
        epoch: number,
        principal: string,
        aclVersion: string,
        membershipVersion: string,
        aclCheckedAt: Date,
        membershipCheckedAt: Date,
        expiresAt: Date,
      ],
    ) {
      return client.query(
        `INSERT INTO ${table('access_proofs')} (id,document_id,membership_id,access_epoch,principal,acl_version,membership_version,acl_checked_at,membership_checked_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (document_id,membership_id) DO UPDATE SET id=EXCLUDED.id,access_epoch=EXCLUDED.access_epoch,principal=EXCLUDED.principal,acl_version=EXCLUDED.acl_version,membership_version=EXCLUDED.membership_version,acl_checked_at=EXCLUDED.acl_checked_at,membership_checked_at=EXCLUDED.membership_checked_at,expires_at=EXCLUDED.expires_at
        WHERE EXCLUDED.acl_checked_at>=${table('access_proofs')}.acl_checked_at AND EXCLUDED.membership_checked_at>=${table('access_proofs')}.membership_checked_at`,
        values,
      );
    },
    readChunk(values: [publicationId: string, ordinal: number]) {
      return client.query(
        `SELECT heading,passage,source_offset FROM ${table('chunks')} WHERE publication_id=$1 AND ordinal=$2`,
        values,
      );
    },
    readWork(values: [revisionId: string]) {
      return client.query(`SELECT * FROM ${table('work')} WHERE revision_id=$1`, values);
    },
    recordFailure(values: [revisionId: string, state: string, failure: string], axis: 'parsing' | 'embedding') {
      return client.query(
        axis === 'embedding'
          ? `UPDATE ${table('work')} SET embedding=$2,failure=$3,attempts=attempts+1 WHERE revision_id=$1 AND attempts<8`
          : `UPDATE ${table('work')} SET parsing=CASE WHEN parsing='ocr-unavailable' THEN parsing ELSE $2 END,failure=CASE WHEN parsing='ocr-unavailable' THEN failure ELSE $3 END,attempts=attempts+1 WHERE revision_id=$1 AND attempts<8`,
        values,
      );
    },
    removeSource(values: [sourceId: string]) {
      return client.query(
        `UPDATE ${table('sources')} SET state='removed',access_epoch=access_epoch+1,removed_at=COALESCE(removed_at,clock_timestamp()),retain_until=COALESCE(retain_until,clock_timestamp()+interval '30 days') WHERE id=$1 AND state<>'removed'`,
        values,
      );
    },
    tombstoneSourceDocuments(values: [sourceId: string]) {
      return client.query(
        `UPDATE ${table('documents')} SET tombstoned_at=COALESCE(tombstoned_at,clock_timestamp()),retain_until=COALESCE(retain_until,clock_timestamp()+interval '30 days'),lexical_publication_id=NULL,vector_publication_id=NULL WHERE source_id=$1`,
        values,
      );
    },
    invalidateSource(values: [sourceId: string, action: string]) {
      return client.query(
        `UPDATE ${table('sources')} SET access_epoch=access_epoch+1,state=CASE WHEN $2='disconnect' THEN 'disconnected' ELSE state END WHERE id=$1`,
        values,
      );
    },
    setSourceState(values: [sourceId: string, state: string]) {
      return client.query(`UPDATE ${table('sources')} SET state=$2 WHERE id=$1`, values);
    },
    validateProofs(values: [documentIds: string[], epochs: number[], membershipId: string]) {
      return client.query(
        `WITH cutoff AS MATERIALIZED (SELECT clock_timestamp() AS at)
        SELECT NOT EXISTS (
          SELECT 1 FROM unnest($1::uuid[], $2::integer[]) AS required(document_id, access_epoch)
          CROSS JOIN cutoff
          WHERE NOT EXISTS (
            SELECT 1 FROM ${table('access_proofs')} p
            WHERE p.document_id=required.document_id AND p.membership_id=$3 AND p.access_epoch=required.access_epoch
              AND p.acl_checked_at<=cutoff.at AND p.membership_checked_at<=cutoff.at AND p.expires_at>cutoff.at
          )
        ) AS allowed`,
        values,
      );
    },
  };
}
