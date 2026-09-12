import type { TransactionPort } from "../ports";

export interface OimKnowledgeSourcePublication {
  readonly businessId: string;
  readonly sourceId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly provider: string;
  readonly externalId: string;
  readonly externalTenantId: string;
  readonly ownerExternalId: string;
  readonly sourceLocator: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly classification: readonly string[];
  readonly verification: "verified";
  readonly accessControlMode: "live" | "snapshot";
  readonly accessControlMaximumAgeSeconds: number;
  readonly aclRevision: string | null;
  readonly aclCapturedAt: string | null;
  readonly aclPrincipals: readonly Readonly<Record<string, string>>[] | null;
  readonly provenanceCapturedAt: string;
  readonly provenanceContentHash: string;
  readonly provenanceCheckpoint: string | null;
  readonly provenanceConnectionId: string;
  readonly lastSyncedAt: string;
}

export interface OimKnowledgeChunkPublication {
  readonly chunkId: string;
  readonly revision: string;
  readonly classification: readonly string[];
  readonly digest: string;
  readonly content: string;
  readonly embedding?: readonly number[] | null;
  readonly model?: string | null;
  readonly dimension?: number | null;
}

export interface PublishOimKnowledgeRevision {
  readonly expectedRevision?: string;
  readonly source: OimKnowledgeSourcePublication;
  readonly chunks: readonly OimKnowledgeChunkPublication[];
}

export interface DeleteOimKnowledgeSource {
  readonly businessId: string;
  readonly sourceId: string;
  readonly expectedRevision: string;
  readonly deletedRevision: string;
  readonly deletedAt: string;
}

function assertPublication(input: PublishOimKnowledgeRevision): void {
  if (
    input.source.businessId.length === 0 ||
    input.source.sourceId.length === 0 ||
    input.source.revision.length === 0 ||
    !Number.isSafeInteger(input.source.integrationMajorVersion) ||
    input.source.integrationMajorVersion < 0 ||
    input.source.provenanceConnectionId.length === 0 ||
    input.source.accessControlMaximumAgeSeconds < 0
  ) {
    throw new Error("invalid_oim_knowledge_publication");
  }
  const chunkIds = new Set<string>();
  for (const chunk of input.chunks) {
    if (
      chunk.chunkId.length === 0 ||
      chunk.revision !== input.source.revision ||
      chunkIds.has(chunk.chunkId)
    ) {
      throw new Error("invalid_oim_knowledge_chunk_publication");
    }
    chunkIds.add(chunk.chunkId);
  }
}

/**
 * Atomic source plus chunk publication for OIM Knowledge.
 *
 * ACL, source revision, and every servable chunk become visible in one commit. Deletion first
 * advances the source tombstone, then removes chunks inside that same transaction.
 */
export class OimKnowledgePublicationStore {
  constructor(private readonly transactions: TransactionPort) {}

  async publish(input: PublishOimKnowledgeRevision): Promise<boolean> {
    assertPublication(input);
    return this.transactions.withTransaction(async (transaction) => {
      const source = input.source;
      const sourceParams = [
        source.sourceId,
        source.businessId,
        source.integrationId,
        source.provider,
        source.externalId,
        source.externalTenantId,
        source.ownerExternalId,
        JSON.stringify(source.sourceLocator),
        source.revision,
        [...source.classification],
        source.verification,
        source.accessControlMode,
        source.accessControlMaximumAgeSeconds,
        source.aclRevision,
        source.aclCapturedAt,
        source.aclPrincipals === null ? null : JSON.stringify(source.aclPrincipals),
        source.provenanceCapturedAt,
        source.provenanceContentHash,
        source.provenanceCheckpoint,
        source.provenanceConnectionId,
        source.integrationMajorVersion,
        source.lastSyncedAt,
      ];
      const persisted =
        input.expectedRevision === undefined
          ? await transaction.query(
              `INSERT INTO knowledge_source_records (
                 source_id, business_id, integration_id, provider, external_id,
                 external_tenant_id, owner_external_id, source_locator, revision,
                 classification, status, verification, access_control_mode,
                 access_control_max_age_seconds, acl_revision, acl_captured_at, acl_principals,
                 provenance_captured_at, provenance_content_hash, provenance_checkpoint,
                 provenance_connection_id, provenance_integration_major_version,
                 last_synced_at, created_at, updated_at
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::text[], 'active', $11, $12,
                 $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21, $22, now(), now()
               )
               ON CONFLICT (business_id, source_id) DO NOTHING
               RETURNING source_id`,
              sourceParams
            )
          : await transaction.query(
              `UPDATE knowledge_source_records
                  SET integration_id = $3,
                      provider = $4,
                      external_id = $5,
                      external_tenant_id = $6,
                      owner_external_id = $7,
                      source_locator = $8::jsonb,
                      revision = $9,
                      classification = $10::text[],
                      status = 'active',
                      verification = $11,
                      access_control_mode = $12,
                      access_control_max_age_seconds = $13,
                      acl_revision = $14,
                      acl_captured_at = $15,
                      acl_principals = $16::jsonb,
                      provenance_captured_at = $17,
                      provenance_content_hash = $18,
                      provenance_checkpoint = $19,
                      provenance_connection_id = $20,
                      provenance_integration_major_version = $21,
                      last_synced_at = $22,
                      updated_at = now()
                WHERE source_id = $1 AND business_id = $2 AND revision = $23
                  AND (
                    provenance_connection_id IS NULL
                    OR (
                      provenance_connection_id = $20
                      AND integration_id = $3
                      AND (
                        provenance_integration_major_version IS NULL
                        OR provenance_integration_major_version = $21
                      )
                    )
                  )
                RETURNING source_id`,
              [...sourceParams, input.expectedRevision]
            );
      if (persisted.rows.length !== 1) return false;

      for (const chunk of input.chunks) {
        const vector = chunk.embedding ?? null;
        const result = await transaction.query(
          `INSERT INTO knowledge_source_chunks (
             business_id, source_id, chunk_id, revision, classification, digest, content,
             embedding, tsv, model, dim, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5::text[], $6, $7, $8::vector,
             to_tsvector('english', $7), $9, $10, now(), now()
           )
           ON CONFLICT (business_id, chunk_id) DO UPDATE SET
             revision = EXCLUDED.revision,
             classification = EXCLUDED.classification,
             digest = EXCLUDED.digest,
             content = EXCLUDED.content,
             embedding = EXCLUDED.embedding,
             tsv = EXCLUDED.tsv,
             model = EXCLUDED.model,
             dim = EXCLUDED.dim,
             updated_at = now()
           WHERE knowledge_source_chunks.source_id = EXCLUDED.source_id
           RETURNING chunk_id`,
          [
            source.businessId,
            source.sourceId,
            chunk.chunkId,
            chunk.revision,
            [...chunk.classification],
            chunk.digest,
            chunk.content,
            vector === null ? null : JSON.stringify(vector),
            vector === null ? null : (chunk.model ?? null),
            vector === null ? null : (chunk.dimension ?? null),
          ]
        );
        if (result.rows.length !== 1) {
          throw new Error(`Knowledge chunk ${chunk.chunkId} belongs to another source`);
        }
      }

      const chunkIds = input.chunks.map(({ chunkId }) => chunkId);
      await transaction.query(
        `DELETE FROM knowledge_source_chunks
          WHERE business_id = $1
            AND source_id = $2
            AND NOT (chunk_id = ANY($3::text[]))`,
        [source.businessId, source.sourceId, chunkIds]
      );
      return true;
    });
  }

  async markDeleted(input: DeleteOimKnowledgeSource): Promise<boolean> {
    if (
      input.businessId.length === 0 ||
      input.sourceId.length === 0 ||
      input.expectedRevision.length === 0 ||
      input.deletedRevision.length === 0 ||
      input.deletedRevision === input.expectedRevision ||
      !Number.isFinite(new Date(input.deletedAt).getTime())
    ) {
      throw new Error("invalid_oim_knowledge_deletion");
    }
    return this.transactions.withTransaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE knowledge_source_records
            SET status = 'deleted',
                revision = $4,
                last_synced_at = $5,
                provenance_captured_at = $5,
                updated_at = now()
          WHERE business_id = $1 AND source_id = $2 AND revision = $3
          RETURNING source_id`,
        [
          input.businessId,
          input.sourceId,
          input.expectedRevision,
          input.deletedRevision,
          input.deletedAt,
        ]
      );
      if (updated.rows.length !== 1) return false;
      await transaction.query(
        "DELETE FROM knowledge_source_chunks WHERE business_id = $1 AND source_id = $2",
        [input.businessId, input.sourceId]
      );
      return true;
    });
  }
}
