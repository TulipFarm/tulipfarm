import type { EmbeddingRepository } from '@tulipfarm/memory-core/ports/embedding-repository';
import type { MemoryQueryClient } from './query-client.ts';
import { memoryTable, type PostgresMemoryNames } from './names.ts';

export function createPostgresEmbeddingRepository(
  client: MemoryQueryClient,
  names: PostgresMemoryNames,
): EmbeddingRepository {
  const table = (name: string) => memoryTable(names, name);
  return {
    installProfile(values: [id: string, profile: unknown]) {
      return client.query(
        `INSERT INTO ${table('embedding_profiles')} (id,profile) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        values,
      );
    },
    profileMatches(values: [id: string, profile: unknown]) {
      return client.query(
        `SELECT profile=$2::jsonb AS matches FROM ${table('embedding_profiles')} WHERE id=$1`,
        values,
      );
    },
    changedEpochJobs(values: [providers: string[]]) {
      return client.query(
        `SELECT j.* FROM ${table('embedding_jobs')} j
      JOIN ${table('documents')} d ON d.id=j.document_id AND d.observed_revision_id=j.revision_id AND d.lexical_publication_id=j.publication_id
      JOIN ${table('sources')} s ON s.id=d.source_id
      WHERE s.provider=ANY($1::text[]) AND s.state='active' AND d.tombstoned_at IS NULL AND s.access_epoch<>j.access_epoch
        AND j.state IN ('queued','capacity-blocked','failed','ready')
        AND (SELECT count(*) FROM ${table('embedding_items')} i JOIN ${table('embedding_cache')} c USING(profile_id,input_hash)
          WHERE i.job_id=j.id AND c.state IN ('queued','ready'))=j.total_chunks
      ORDER BY j.id LIMIT 100 FOR UPDATE OF j`,
        values,
      );
    },
    rebindEpoch(values: [id: string, epoch: number]) {
      return client.query(
        `UPDATE ${table('embedding_jobs')} SET access_epoch=$2,generation=generation+1,state='queued',dispatch_after=clock_timestamp() WHERE id=$1`,
        values,
      );
    },
    lockJob(values: [id: string]) {
      return client.query(`SELECT * FROM ${table('embedding_jobs')} WHERE id=$1 FOR UPDATE`, values);
    },
    lockQueryJob(values: [membershipId: string, commandId: string]) {
      return client.query(
        `SELECT * FROM ${table('embedding_jobs')} WHERE owner_membership_id=$1 AND command_id=$2 FOR UPDATE`,
        values,
      );
    },
    invalidateInput(values: [jobId: string]) {
      return client.query(`UPDATE ${table('embedding_jobs')} SET state='invalid-input' WHERE id=$1`, values);
    },
    insertCache(values: [profileId: string, items: string]) {
      return client.query(
        `INSERT INTO ${table('embedding_cache')} (profile_id,input_hash)
      SELECT DISTINCT $1,input_hash FROM jsonb_to_recordset($2::jsonb) AS i(input_hash text) ON CONFLICT DO NOTHING`,
        values,
      );
    },
    insertItems(values: [jobId: string, profileId: string, items: string]) {
      return client.query(
        `INSERT INTO ${table('embedding_items')} (job_id,ordinal,profile_id,input_hash,input_text,tokens)
      SELECT $1,ordinal,$2,input_hash,input_text,tokens FROM jsonb_to_recordset($3::jsonb) AS i(ordinal integer,input_hash text,input_text text,tokens integer)`,
        values,
      );
    },
    hasItems(values: [jobId: string]) {
      return client.query(`SELECT 1 FROM ${table('embedding_items')} WHERE job_id=$1 LIMIT 1`, values);
    },
    publicationPassages(values: [publicationId: string]) {
      return client.query(`SELECT passage FROM ${table('chunks')} WHERE publication_id=$1 ORDER BY ordinal`, values);
    },
    counts(values: [jobId: string]) {
      return client.query(
        `SELECT count(*)::int AS total,
      count(v.input_hash)::int AS completed, COALESCE(bool_or(c.state IN ('claimed','dispatched')) FILTER (WHERE v.input_hash IS NULL),false) AS busy,
      COALESCE(bool_or(c.state='unknown') FILTER (WHERE v.input_hash IS NULL),false) AS unknown,
      COALESCE(bool_or(c.state='failed') FILTER (WHERE v.input_hash IS NULL),false) AS failed,
      COALESCE(bool_or(c.attempts>=8 AND c.state<>'ready') FILTER (WHERE v.input_hash IS NULL),false) AS exhausted
      FROM ${table('embedding_items')} i JOIN ${table('embedding_cache')} c USING (profile_id,input_hash)
      LEFT JOIN ${table('embedding_vectors')} v USING (profile_id,input_hash) WHERE i.job_id=$1`,
        values,
      );
    },
    queryVector(values: [jobId: string]) {
      return client.query(
        `SELECT v.vector FROM ${table('embedding_items')} i JOIN ${table('embedding_vectors')} v USING (profile_id,input_hash) WHERE i.job_id=$1 AND i.ordinal=0`,
        values,
      );
    },
    publicationVectors(values: [jobId: string, publicationId: string, profileId: string, chunks: number]) {
      return client.query(
        `SELECT i.ordinal,i.input_hash,v.vector
        FROM ${table('embedding_items')} i
        JOIN ${table('publications')} p ON p.id=$2 AND p.chunk_count=$4
        JOIN ${table('chunks')} k ON k.publication_id=p.id AND k.ordinal=i.ordinal AND k.passage=i.input_text
        JOIN ${table('embedding_vectors')} v ON v.profile_id=i.profile_id AND v.input_hash=i.input_hash
        WHERE i.job_id=$1 AND i.profile_id=$3 ORDER BY i.ordinal`,
        values,
      );
    },
    insertVectorPublication(
      values: [
        id: string,
        documentId: string,
        revisionId: string,
        publicationId: string,
        profile: unknown,
        profileId: string,
      ],
    ) {
      return client.query(
        `INSERT INTO ${table('vector_publications')}
        (id,document_id,revision_id,lexical_publication_id,profile,profile_id)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (lexical_publication_id,profile_id) DO NOTHING RETURNING id`,
        values,
      );
    },
    vectorPublication(values: [publicationId: string, profileId: string]) {
      return client.query(
        `SELECT id FROM ${table('vector_publications')} WHERE lexical_publication_id=$1 AND profile_id=$2`,
        values,
      );
    },
    insertSearchVectors(values: [id: string, publicationId: string, profileId: string, chunks: string]) {
      return client.query(
        `INSERT INTO ${table('search_vectors')} (vector_publication_id,lexical_publication_id,ordinal,profile_id,input_hash,embedding)
        SELECT $1,$2,i.ordinal,$3,i.input_hash,i.vector::text::extensions.vector(1536)
        FROM jsonb_to_recordset($4::jsonb) AS i(ordinal integer,input_hash text,vector jsonb)
        ON CONFLICT DO NOTHING`,
        values,
      );
    },
    publishVectors(
      values: [documentId: string, revisionId: string, publicationId: string, vectorPublicationId: string],
    ) {
      return client.query(
        `UPDATE ${table('documents')} SET vector_publication_id=$4
        WHERE id=$1 AND observed_revision_id=$2 AND lexical_publication_id=$3 AND tombstoned_at IS NULL`,
        values,
      );
    },
    completeWork(values: [revisionId: string]) {
      return client.query(`UPDATE ${table('work')} SET embedding='ready' WHERE revision_id=$1`, values);
    },
    completeJob(values: [jobId: string]) {
      return client.query(`UPDATE ${table('embedding_jobs')} SET state='ready' WHERE id=$1`, values);
    },
    readQueryJob(values: [membershipId: string, commandId: string]) {
      return client.query(
        `SELECT * FROM ${table('embedding_jobs')} WHERE owner_membership_id=$1 AND command_id=$2`,
        values,
      );
    },
    queryBinding(values: [jobId: string, filters: unknown, taskFlowId: string | null]) {
      return client.query(
        `SELECT 1 FROM ${table('search_queries')} WHERE job_id=$1 AND filters=$2::jsonb AND task_flow_id IS NOT DISTINCT FROM $3`,
        values,
      );
    },
    queryCount(values: [membershipId: string]) {
      return client.query(
        `SELECT count(*)::int AS count FROM ${table('embedding_jobs')} WHERE owner_membership_id=$1 AND purpose='query'`,
        values,
      );
    },
    insertQueryJob(
      values: [
        id: string,
        membershipId: string,
        userId: string,
        profileId: string,
        commandId: string,
        fingerprint: string,
      ],
    ) {
      return client.query(
        `INSERT INTO ${table('embedding_jobs')} (id,purpose,owner_membership_id,owner_user_id,profile_id,command_id,query_fingerprint,total_chunks) VALUES ($1,'query',$2,$3,$4,$5,$6,1)`,
        values,
      );
    },
    insertQuery(values: [jobId: string, filters: unknown, expiresAt: Date, taskFlowId: string | null]) {
      return client.query(
        `INSERT INTO ${table('search_queries')} (job_id,filters,expires_at,task_flow_id) VALUES ($1,$2,$3,$4)`,
        values,
      );
    },
    cancelQuery(values: [jobId: string]) {
      return client.query(`UPDATE ${table('search_queries')} SET cancelled=true WHERE job_id=$1`, values);
    },
    readRetry(values: [membershipId: string, commandId: string]) {
      return client.query(
        `SELECT * FROM ${table('embedding_retries')} WHERE membership_id=$1 AND command_id=$2`,
        values,
      );
    },
    resetRetryCache(values: [jobId: string]) {
      return client.query(
        `UPDATE ${table('embedding_cache')} c SET state='queued',attempt_id=NULL,lease_until=NULL FROM ${table('embedding_items')} i
      WHERE i.job_id=$1 AND c.profile_id=i.profile_id AND c.input_hash=i.input_hash AND c.state IN ('failed','unknown') AND c.attempts<8`,
        values,
      );
    },
    retryJob(values: [jobId: string, epoch: number | null]) {
      return client.query(
        `UPDATE ${table('embedding_jobs')} SET generation=generation+1,retry_count=retry_count+1,access_epoch=$2,state='queued',dispatch_after=clock_timestamp() WHERE id=$1`,
        values,
      );
    },
    insertRetry(values: [membershipId: string, commandId: string, jobId: string, generation: number]) {
      return client.query(
        `INSERT INTO ${table('embedding_retries')} (membership_id,command_id,job_id,expected_generation) VALUES ($1,$2,$3,$4)`,
        values,
      );
    },
    hasUndiscovered(values: [profileId: string, documentId: string | null]) {
      return client.query(
        `SELECT 1 FROM ${table('documents')} d
      WHERE d.tombstoned_at IS NULL AND d.lexical_publication_id IS NOT NULL
        AND ($2::uuid IS NULL OR d.id=$2)
        AND NOT EXISTS (SELECT 1 FROM ${table('embedding_jobs')} j WHERE j.publication_id=d.lexical_publication_id AND j.profile_id=$1)
      LIMIT 1`,
        values,
      );
    },
    insertIngestionJob(
      values: [
        id: string,
        membershipId: string,
        userId: string,
        profileId: string,
        documentId: string,
        revisionId: string,
        publicationId: string,
        epoch: number,
        chunks: number,
      ],
    ) {
      return client.query(
        `INSERT INTO ${table('embedding_jobs')} (id,purpose,owner_membership_id,owner_user_id,profile_id,document_id,revision_id,publication_id,access_epoch,total_chunks)
      VALUES ($1,'ingestion',$2,$3,$4,$5,$6,$7,$8,$9)`,
        values,
      );
    },
    failJob(values: [jobId: string]) {
      return client.query(`UPDATE ${table('embedding_jobs')} SET state='failed' WHERE id=$1`, values);
    },
    expiredClaims() {
      return client.query(
        `SELECT profile_id,input_hash,attempt_id,state FROM ${table('embedding_cache')} WHERE state IN ('claimed','dispatched') AND lease_until<=clock_timestamp() ORDER BY profile_id,input_hash LIMIT 100 FOR UPDATE`,
      );
    },
    recoverClaim(values: [profileId: string, hash: string, state: string]) {
      return client.query(
        `UPDATE ${table('embedding_cache')} SET state=$3,lease_until=NULL WHERE profile_id=$1 AND input_hash=$2`,
        values,
      );
    },
    rebindOwner(values: [jobId: string, membershipId: string, userId: string]) {
      return client.query(
        `UPDATE ${table('embedding_jobs')} SET owner_membership_id=$2,owner_user_id=$3,generation=generation+1,
            state=CASE WHEN state='ready' THEN 'ready' ELSE 'queued' END,dispatch_after=clock_timestamp() WHERE id=$1`,
        values,
      );
    },
    dueJobs(values: [profileId: string, held: string[]]) {
      return client.query(
        `SELECT j.* FROM ${table('embedding_jobs')} j
        WHERE ((j.state IN ('queued','capacity-blocked') AND j.dispatch_after<=clock_timestamp())
          OR (j.purpose='ingestion' AND j.profile_id=$1
            AND EXISTS (SELECT 1 FROM ${table('documents')} d JOIN ${table('sources')} s ON s.id=d.source_id
              WHERE d.id=j.document_id AND d.observed_revision_id=j.revision_id AND d.lexical_publication_id=j.publication_id
                AND d.tombstoned_at IS NULL AND s.state='active' AND s.access_epoch=j.access_epoch
                AND NOT EXISTS (SELECT 1 FROM ${table('vector_publications')} p WHERE p.id=d.vector_publication_id AND p.profile_id=j.profile_id))
            AND (SELECT count(*) FROM ${table('embedding_items')} i JOIN ${table('embedding_vectors')} v USING (profile_id,input_hash)
              WHERE i.job_id=j.id)=j.total_chunks))
          AND NOT (j.purpose='ingestion' AND EXISTS (SELECT 1 FROM ${table('documents')} d WHERE d.id=j.document_id AND d.source_id=ANY($2::uuid[])))
        ORDER BY j.dispatch_after,j.id LIMIT 100`,
        values,
      );
    },
    deferJob(values: [jobId: string]) {
      return client.query(
        `UPDATE ${table('embedding_jobs')} SET dispatch_after=clock_timestamp()+interval '30 seconds' WHERE id=$1`,
        values,
      );
    },
    setJobState(values: [jobId: string, state: string]) {
      return client.query(`UPDATE ${table('embedding_jobs')} SET state=$2 WHERE id=$1`, values);
    },
    documentJob(
      values: [documentId: string, revisionId: string | null, publicationId: string | null, profileId: string],
    ) {
      return client.query(
        `SELECT * FROM ${table('embedding_jobs')} WHERE document_id=$1 AND revision_id=$2 AND publication_id=$3 AND profile_id=$4`,
        values,
      );
    },
    documentVectors(values: [jobId: string]) {
      return client.query(
        `SELECT i.ordinal,i.input_hash AS "inputHash",v.vector FROM ${table('embedding_items')} i JOIN ${table('embedding_vectors')} v USING (profile_id,input_hash) WHERE i.job_id=$1 ORDER BY i.ordinal`,
        values,
      );
    },
    retryJobId(values: [membershipId: string, commandId: string]) {
      return client.query(
        `SELECT job_id FROM ${table('embedding_retries')} WHERE membership_id=$1 AND command_id=$2`,
        values,
      );
    },
    insertVector(values: [profileId: string, hash: string, vector: string, attemptId: string]) {
      return client.query(
        `INSERT INTO ${table('embedding_vectors')} (profile_id,input_hash,vector,attempt_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        values,
      );
    },
    settleClaim(values: [profileId: string, hash: string, attemptId: string, state: string]) {
      return client.query(
        `UPDATE ${table('embedding_cache')} c SET state=CASE
            WHEN EXISTS (SELECT 1 FROM ${table('embedding_vectors')} v WHERE v.profile_id=c.profile_id AND v.input_hash=c.input_hash) THEN 'ready' ELSE $4 END,
            lease_until=NULL WHERE profile_id=$1 AND input_hash=$2 AND attempt_id=$3`,
        values,
      );
    },
    queryTaskFlow(values: [jobId: string]) {
      return client.query(`SELECT task_flow_id FROM ${table('search_queries')} WHERE job_id=$1`, values);
    },
    heldDocument(values: [documentId: string, held: string[]]) {
      return client.query(`SELECT 1 FROM ${table('documents')} WHERE id=$1 AND source_id=ANY($2::uuid[])`, values);
    },
    nextItem(values: [jobId: string]) {
      return client.query(
        `SELECT i.* FROM ${table('embedding_items')} i LEFT JOIN ${table('embedding_vectors')} v USING (profile_id,input_hash) WHERE i.job_id=$1 AND v.input_hash IS NULL ORDER BY i.ordinal LIMIT 1`,
        values,
      );
    },
    lockCache(values: [profileId: string, hash: string]) {
      return client.query(
        `SELECT * FROM ${table('embedding_cache')} WHERE profile_id=$1 AND input_hash=$2 FOR UPDATE`,
        values,
      );
    },
    claim(values: [profileId: string, hash: string, attemptId: string, deadline: Date | null]) {
      return client.query(
        `UPDATE ${table('embedding_cache')} SET state='claimed',attempt_id=$3,lease_until=least(clock_timestamp()+interval '2 minutes',COALESCE($4::timestamptz,'infinity')) WHERE profile_id=$1 AND input_hash=$2`,
        values,
      );
    },
    ownsClaim(values: [profileId: string, hash: string, attemptId: string]) {
      return client.query(
        `SELECT 1 FROM ${table('embedding_cache')} WHERE profile_id=$1 AND input_hash=$2 AND attempt_id=$3 AND state='claimed' AND lease_until>clock_timestamp() FOR UPDATE`,
        values,
      );
    },
    hasVector(values: [profileId: string, hash: string]) {
      return client.query(`SELECT 1 FROM ${table('embedding_vectors')} WHERE profile_id=$1 AND input_hash=$2`, values);
    },
    completeCache(values: [profileId: string, hash: string]) {
      return client.query(
        `UPDATE ${table('embedding_cache')} SET state='ready',lease_until=NULL WHERE profile_id=$1 AND input_hash=$2`,
        values,
      );
    },
    dispatchJobState(values: [jobId: string, state: string]) {
      return client.query(
        `UPDATE ${table('embedding_jobs')} SET state=$2,dispatch_after=clock_timestamp() WHERE id=$1`,
        values,
      );
    },
    releaseClaim(values: [profileId: string, hash: string]) {
      return client.query(
        `UPDATE ${table('embedding_cache')} SET state='queued',attempt_id=NULL,lease_until=NULL WHERE profile_id=$1 AND input_hash=$2`,
        values,
      );
    },
    deferJobState(values: [jobId: string, state: string]) {
      return client.query(
        `UPDATE ${table('embedding_jobs')} SET state=$2,dispatch_after=clock_timestamp()+interval '30 seconds' WHERE id=$1`,
        values,
      );
    },
    dispatchClaim(values: [profileId: string, hash: string]) {
      return client.query(
        `UPDATE ${table('embedding_cache')} SET state='dispatched',attempts=attempts+1,lease_until=clock_timestamp()+interval '5 minutes' WHERE profile_id=$1 AND input_hash=$2`,
        values,
      );
    },
    queueJob(values: [jobId: string]) {
      return client.query(`UPDATE ${table('embedding_jobs')} SET state='queued' WHERE id=$1`, values);
    },
  };
}
