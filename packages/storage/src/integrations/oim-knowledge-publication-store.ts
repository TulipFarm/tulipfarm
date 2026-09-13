import type { Queryable, TransactionPort } from "../ports";

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
  readonly claim: OimKnowledgePublicationClaim;
  readonly source: OimKnowledgeSourcePublication;
  readonly chunks: readonly OimKnowledgeChunkPublication[];
}

export interface OimKnowledgeConnectionFenceScope {
  readonly businessId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
  readonly externalTenantId: string;
  readonly externalAccountId: string;
}

export interface OimKnowledgeConnectionFenceClaim extends OimKnowledgeConnectionFenceScope {
  readonly connectionGeneration: number;
}

export interface OimKnowledgePublicationClaim extends OimKnowledgeConnectionFenceClaim {
  readonly sourceKindId: string;
  readonly scope: string;
  readonly scanId: string;
  readonly leaseToken: string;
  readonly checkpointRevision: number;
}

export interface DeleteOimKnowledgeSource {
  readonly claim: OimKnowledgePublicationClaim;
  readonly businessId: string;
  readonly sourceId: string;
  readonly expectedRevision: string;
  readonly deletedRevision: string;
  readonly deletedAt: string;
}

export interface OimKnowledgePublishedRevision {
  readonly businessId: string;
  readonly sourceId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number | null;
  readonly connectionId: string | null;
  readonly sourceLocator: Readonly<Record<string, unknown>> | null;
  readonly revision: string;
  readonly verification: "verified" | "unverifiable";
  readonly status: "active" | "revoked" | "deleted";
}

export interface QuarantineOimKnowledgeSource {
  readonly claim: OimKnowledgePublicationClaim;
  readonly businessId: string;
  readonly sourceId: string;
  readonly expectedRevision: string;
  readonly quarantinedRevision: string;
  readonly quarantinedAt: string;
}

export interface QuarantineOimKnowledgeScope {
  readonly claim: OimKnowledgePublicationClaim;
  readonly businessId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
  readonly sourceKindId: string;
  readonly scope: string;
  readonly quarantinedRevisionPrefix: string;
  readonly quarantinedAt: string;
}

export interface TombstoneOimKnowledgeConnection {
  readonly businessId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
  readonly deletedRevisionPrefix: string;
  readonly deletedAt: string;
}

export type QuarantineInvalidOimKnowledgeConnection = TombstoneOimKnowledgeConnection;

export const OIM_KNOWLEDGE_PUBLICATION_FENCE_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE oim_knowledge_connection_fences (
     business_id                 text NOT NULL,
     integration_id              text NOT NULL,
     integration_major_version   integer NOT NULL CHECK (integration_major_version >= 0),
     connection_id               text NOT NULL,
     generation                  bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
     status                      text NOT NULL CHECK (status IN ('active', 'blocked')),
     external_tenant_id          text,
     external_account_id         text,
     updated_at                  timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (
       business_id, integration_id, integration_major_version, connection_id
     ),
     CHECK (
       status = 'blocked'
       OR (
         external_tenant_id IS NOT NULL
         AND length(external_tenant_id) > 0
         AND external_account_id IS NOT NULL
         AND length(external_account_id) > 0
       )
     )
   )`,
  `CREATE OR REPLACE FUNCTION oim_knowledge_fence_connection_lifecycle()
   RETURNS trigger
   LANGUAGE plpgsql
   AS $$
   DECLARE
     fenced_generation bigint;
   BEGIN
     IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' THEN
       INSERT INTO oim_knowledge_connection_fences (
         business_id, integration_id, integration_major_version, connection_id,
         generation, status, updated_at
       ) VALUES (
         NEW.business_id, NEW.integration_id, NEW.integration_major_version, NEW.id,
         1, 'blocked', now()
       )
       ON CONFLICT (
         business_id, integration_id, integration_major_version, connection_id
       ) DO UPDATE SET
         generation = oim_knowledge_connection_fences.generation + 1,
         status = 'blocked',
         updated_at = now()
       RETURNING generation INTO fenced_generation;

       UPDATE oim_knowledge_scan_checkpoints
          SET baseline_item_ids = '[]'::jsonb,
              scan_id = NULL,
              continuation = NULL,
              accumulated_seen_item_ids = '[]'::jsonb,
              pending_deletion_item_ids = '[]'::jsonb,
              cursor_watermark = NULL,
              pending_cursor_watermark = NULL,
              requires_full_rebuild = false,
              lease_token = NULL,
              lease_expires_at = NULL,
              revision = revision + 1,
              updated_at = now()
        WHERE business_id = NEW.business_id
          AND integration_id = NEW.integration_id
          AND integration_major_version = NEW.integration_major_version
          AND connection_id = NEW.id;

       UPDATE knowledge_source_records
          SET status = 'deleted',
              verification = 'unverifiable',
              revision = 'connection-revoked:' || fenced_generation || ':' || source_id,
              acl_revision = NULL,
              acl_captured_at = NULL,
              acl_principals = NULL,
              last_synced_at = now(),
              provenance_captured_at = now(),
              updated_at = now()
        WHERE business_id = NEW.business_id
          AND integration_id = NEW.integration_id
          AND provenance_integration_major_version = NEW.integration_major_version
          AND provenance_connection_id = NEW.id
          AND source_locator ->> 'kind' = 'oim';

       DELETE FROM knowledge_source_chunks chunk
        USING knowledge_source_records source
        WHERE chunk.business_id = source.business_id
          AND chunk.source_id = source.source_id
          AND source.business_id = NEW.business_id
          AND source.integration_id = NEW.integration_id
          AND source.provenance_integration_major_version = NEW.integration_major_version
          AND source.provenance_connection_id = NEW.id
          AND source.source_locator ->> 'kind' = 'oim';
     ELSIF NEW.status = 'active'
       AND OLD.status = 'active'
       AND (
         NEW.health_status IS DISTINCT FROM OLD.health_status
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       )
     THEN
       UPDATE oim_knowledge_connection_fences
          SET generation = generation + 1,
              updated_at = now()
        WHERE business_id = NEW.business_id
          AND integration_id = NEW.integration_id
          AND integration_major_version = NEW.integration_major_version
          AND connection_id = NEW.id
          AND status = 'active';
     END IF;
     RETURN NEW;
   END;
   $$`,
  `CREATE TRIGGER oim_knowledge_connection_lifecycle_fence
     AFTER UPDATE OF status, health_status, expires_at ON connections
     FOR EACH ROW
     EXECUTE FUNCTION oim_knowledge_fence_connection_lifecycle()`,
];

function assertPublication(input: PublishOimKnowledgeRevision): void {
  const locator = input.source.sourceLocator;
  const claim = input.claim;
  const invalidOimLocator =
    locator.kind !== "oim" ||
    typeof locator.integrationSlug !== "string" ||
    locator.integrationSlug.length === 0 ||
    locator.integrationId !== input.source.integrationId ||
    locator.integrationMajorVersion !== input.source.integrationMajorVersion ||
    locator.connectionId !== input.source.provenanceConnectionId ||
    locator.externalTenantId !== input.source.externalTenantId ||
    locator.externalAccountId !== input.source.ownerExternalId ||
    typeof locator.sourceKindId !== "string" ||
    locator.sourceKindId.length === 0 ||
    typeof locator.scope !== "string" ||
    locator.scope.length === 0 ||
    locator.itemId !== input.source.externalId;
  const invalidClaim =
    claim === undefined ||
    !publicationClaimIsValid(claim) ||
    claim.businessId !== input.source.businessId ||
    claim.integrationId !== input.source.integrationId ||
    claim.integrationMajorVersion !== input.source.integrationMajorVersion ||
    claim.connectionId !== input.source.provenanceConnectionId ||
    claim.externalTenantId !== input.source.externalTenantId ||
    claim.externalAccountId !== input.source.ownerExternalId ||
    claim.sourceKindId !== locator.sourceKindId ||
    claim.scope !== locator.scope;
  if (
    input.source.businessId.length === 0 ||
    input.source.sourceId.length === 0 ||
    input.source.revision.length === 0 ||
    input.source.integrationId.length === 0 ||
    input.source.provider !== input.source.integrationId ||
    !Number.isSafeInteger(input.source.integrationMajorVersion) ||
    input.source.integrationMajorVersion < 0 ||
    input.source.provenanceConnectionId.length === 0 ||
    input.source.accessControlMaximumAgeSeconds < 0 ||
    invalidOimLocator ||
    invalidClaim
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

function publicationClaimIsValid(claim: OimKnowledgePublicationClaim): boolean {
  return (
    claim.businessId.length > 0 &&
    claim.integrationId.length > 0 &&
    Number.isSafeInteger(claim.integrationMajorVersion) &&
    claim.integrationMajorVersion >= 0 &&
    claim.connectionId.length > 0 &&
    claim.externalTenantId.length > 0 &&
    claim.externalAccountId.length > 0 &&
    Number.isSafeInteger(claim.connectionGeneration) &&
    claim.connectionGeneration >= 1 &&
    claim.sourceKindId.length > 0 &&
    claim.scope.length > 0 &&
    claim.scanId.length > 0 &&
    claim.leaseToken.length > 0 &&
    Number.isSafeInteger(claim.checkpointRevision) &&
    claim.checkpointRevision >= 1
  );
}

/**
 * Atomic source plus chunk publication for OIM Knowledge.
 *
 * ACL, source revision, and every servable chunk become visible in one commit. Deletion first
 * advances the source tombstone, then removes chunks inside that same transaction.
 */
export class OimKnowledgePublicationStore {
  constructor(private readonly transactions: TransactionPort) {}

  async claimConnection(
    input: OimKnowledgeConnectionFenceScope
  ): Promise<OimKnowledgeConnectionFenceClaim | null> {
    assertConnectionFenceScope(input);
    return this.transactions.withTransaction((transaction) =>
      captureConnectionFence(transaction, input, false)
    );
  }

  async activateConnection(
    input: OimKnowledgeConnectionFenceScope
  ): Promise<OimKnowledgeConnectionFenceClaim | null> {
    assertConnectionFenceScope(input);
    return this.transactions.withTransaction((transaction) =>
      captureConnectionFence(transaction, input, true)
    );
  }

  async find(businessId: string, sourceId: string): Promise<OimKnowledgePublishedRevision | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{
        business_id: string;
        source_id: string;
        integration_id: string;
        provenance_integration_major_version: number | null;
        provenance_connection_id: string | null;
        source_locator: Readonly<Record<string, unknown>> | null;
        revision: string;
        verification: OimKnowledgePublishedRevision["verification"];
        status: OimKnowledgePublishedRevision["status"];
      }>(
        `SELECT business_id, source_id, integration_id, provenance_integration_major_version,
                provenance_connection_id, source_locator, revision, verification, status
           FROM knowledge_source_records
          WHERE business_id = $1 AND source_id = $2`,
        [businessId, sourceId]
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            businessId: row.business_id,
            sourceId: row.source_id,
            integrationId: row.integration_id,
            integrationMajorVersion: row.provenance_integration_major_version,
            connectionId: row.provenance_connection_id,
            sourceLocator: row.source_locator,
            revision: row.revision,
            verification: row.verification,
            status: row.status,
          };
    });
  }

  async publish(input: PublishOimKnowledgeRevision): Promise<boolean> {
    assertPublication(input);
    return this.transactions.withTransaction(async (transaction) => {
      if (!(await publicationClaimIsCurrent(transaction, input.claim))) return false;
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
                  AND provenance_connection_id = $20
                  AND integration_id = $3
                  AND provenance_integration_major_version = $21
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
      !publicationClaimIsValid(input.claim) ||
      input.claim.businessId !== input.businessId ||
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
      if (!(await publicationClaimIsCurrent(transaction, input.claim))) return false;
      const updated = await transaction.query(
        `UPDATE knowledge_source_records
            SET status = 'deleted',
                verification = 'unverifiable',
                revision = $4,
                acl_revision = NULL,
                acl_captured_at = NULL,
                acl_principals = NULL,
                last_synced_at = $5,
                provenance_captured_at = $5,
                updated_at = now()
          WHERE business_id = $1
            AND source_id = $2
            AND revision = $3
            AND source_locator ->> 'kind' = 'oim'
            AND integration_id = $6
            AND provenance_integration_major_version = $7
            AND provenance_connection_id = $8
            AND external_tenant_id = $9
            AND owner_external_id = $10
            AND source_locator ->> 'sourceKindId' = $11
            AND source_locator ->> 'scope' = $12
          RETURNING source_id`,
        [
          input.businessId,
          input.sourceId,
          input.expectedRevision,
          input.deletedRevision,
          input.deletedAt,
          input.claim.integrationId,
          input.claim.integrationMajorVersion,
          input.claim.connectionId,
          input.claim.externalTenantId,
          input.claim.externalAccountId,
          input.claim.sourceKindId,
          input.claim.scope,
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

  async quarantineSource(input: QuarantineOimKnowledgeSource): Promise<boolean> {
    if (
      !publicationClaimIsValid(input.claim) ||
      input.claim.businessId !== input.businessId ||
      input.businessId.length === 0 ||
      input.sourceId.length === 0 ||
      input.expectedRevision.length === 0 ||
      input.quarantinedRevision.length === 0 ||
      input.quarantinedRevision === input.expectedRevision ||
      !Number.isFinite(new Date(input.quarantinedAt).getTime())
    ) {
      throw new Error("invalid_oim_knowledge_quarantine");
    }
    return this.transactions.withTransaction(async (transaction) => {
      if (!(await publicationClaimIsCurrent(transaction, input.claim))) return false;
      const updated = await transaction.query(
        `UPDATE knowledge_source_records
            SET verification = 'unverifiable',
                revision = $4,
                acl_revision = NULL,
                acl_captured_at = NULL,
                acl_principals = NULL,
                last_synced_at = $5,
                provenance_captured_at = $5,
                updated_at = now()
          WHERE business_id = $1
            AND source_id = $2
            AND revision = $3
            AND source_locator ->> 'kind' = 'oim'
            AND integration_id = $6
            AND provenance_integration_major_version = $7
            AND provenance_connection_id = $8
            AND external_tenant_id = $9
            AND owner_external_id = $10
            AND source_locator ->> 'sourceKindId' = $11
            AND source_locator ->> 'scope' = $12
          RETURNING source_id`,
        [
          input.businessId,
          input.sourceId,
          input.expectedRevision,
          input.quarantinedRevision,
          input.quarantinedAt,
          input.claim.integrationId,
          input.claim.integrationMajorVersion,
          input.claim.connectionId,
          input.claim.externalTenantId,
          input.claim.externalAccountId,
          input.claim.sourceKindId,
          input.claim.scope,
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

  async quarantineScope(input: QuarantineOimKnowledgeScope): Promise<readonly string[] | null> {
    assertExactScope(input);
    return this.transactions.withTransaction(async (transaction) => {
      if (!(await publicationClaimIsCurrent(transaction, input.claim))) return null;
      await transaction.query(
        `UPDATE oim_knowledge_scan_checkpoints
            SET scan_id = COALESCE(scan_id, 'rebuild:' || (revision + 1)::text),
                continuation = NULL,
                accumulated_seen_item_ids = '[]'::jsonb,
                cursor_watermark = NULL,
                pending_cursor_watermark = NULL,
                requires_full_rebuild = true,
                lease_token = NULL,
                lease_expires_at = NULL,
                revision = revision + 1,
            updated_at = $7
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id = $4
            AND source_kind = $5
            AND scope_key = $6`,
        [
          input.businessId,
          input.integrationId,
          input.integrationMajorVersion,
          input.connectionId,
          input.sourceKindId,
          input.scope,
          input.quarantinedAt,
        ]
      );
      const updated = await transaction.query<{ source_id: string }>(
        `UPDATE knowledge_source_records
            SET verification = 'unverifiable',
                revision = $9 || ':' || source_id,
                acl_revision = NULL,
                acl_captured_at = NULL,
                acl_principals = NULL,
                last_synced_at = $10,
                provenance_captured_at = $10,
                updated_at = now()
          WHERE business_id = $1
            AND integration_id = $2
            AND provenance_integration_major_version = $3
            AND provenance_connection_id = $4
            AND source_locator ->> 'kind' = 'oim'
            AND source_locator ->> 'sourceKindId' = $5
            AND source_locator ->> 'scope' = $6
            AND external_tenant_id = $7
            AND owner_external_id = $8
          RETURNING source_id`,
        [
          input.businessId,
          input.integrationId,
          input.integrationMajorVersion,
          input.connectionId,
          input.sourceKindId,
          input.scope,
          input.claim.externalTenantId,
          input.claim.externalAccountId,
          input.quarantinedRevisionPrefix,
          input.quarantinedAt,
        ]
      );
      const sourceIds = updated.rows.map(({ source_id }) => source_id).sort();
      if (sourceIds.length > 0) {
        await transaction.query(
          `DELETE FROM knowledge_source_chunks
            WHERE business_id = $1 AND source_id = ANY($2::text[])`,
          [input.businessId, sourceIds]
        );
      }
      return sourceIds;
    });
  }

  async tombstoneConnection(input: TombstoneOimKnowledgeConnection): Promise<readonly string[]> {
    assertExactScope(input);
    return this.transactions.withTransaction((transaction) =>
      tombstoneConnectionInTransaction(transaction, input)
    );
  }

  /**
   * Fails closed only while the authoritative Connection or verified identity is still invalid.
   * A concurrent reauthorization wins by making this return null without installing a fence.
   */
  async quarantineInvalidConnection(
    input: QuarantineInvalidOimKnowledgeConnection
  ): Promise<readonly string[] | null> {
    assertExactScope(input);
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await transaction.query<{ currently_valid: boolean }>(
        `SELECT (
           status = 'active'
           AND health_status <> 'action_required'
           AND (expires_at IS NULL OR expires_at > now())
         ) AS currently_valid
           FROM connections
          WHERE business_id = $1
            AND id = $2
            AND integration_id = $3
            AND integration_major_version = $4
          FOR UPDATE`,
        [input.businessId, input.connectionId, input.integrationId, input.integrationMajorVersion]
      );
      const current = connection.rows[0];
      if (current === undefined) return null;

      const identity = await transaction.query(
        `SELECT connection_id
           FROM connection_external_identities
          WHERE business_id = $1
            AND connection_id = $2
            AND integration_id = $3
            AND integration_major_version = $4
          FOR UPDATE`,
        [input.businessId, input.connectionId, input.integrationId, input.integrationMajorVersion]
      );
      if (current.currently_valid && identity.rows.length === 1) return null;
      return tombstoneConnectionInTransaction(transaction, input);
    });
  }
}

async function tombstoneConnectionInTransaction(
  transaction: Queryable,
  input: TombstoneOimKnowledgeConnection
): Promise<readonly string[]> {
  await transaction.query(
    `INSERT INTO oim_knowledge_connection_fences (
       business_id, integration_id, integration_major_version, connection_id,
       generation, status, updated_at
     ) VALUES ($1, $2, $3, $4, 1, 'blocked', $5)
     ON CONFLICT (
       business_id, integration_id, integration_major_version, connection_id
     ) DO UPDATE SET
       generation = CASE
         WHEN oim_knowledge_connection_fences.status = 'active'
           THEN oim_knowledge_connection_fences.generation + 1
         ELSE oim_knowledge_connection_fences.generation
       END,
       status = 'blocked',
       updated_at = $5`,
    [
      input.businessId,
      input.integrationId,
      input.integrationMajorVersion,
      input.connectionId,
      input.deletedAt,
    ]
  );
  await transaction.query(
    `UPDATE oim_knowledge_scan_checkpoints
        SET baseline_item_ids = '[]'::jsonb,
            scan_id = NULL,
            continuation = NULL,
            accumulated_seen_item_ids = '[]'::jsonb,
            pending_deletion_item_ids = '[]'::jsonb,
            cursor_watermark = NULL,
            pending_cursor_watermark = NULL,
            requires_full_rebuild = false,
            lease_token = NULL,
            lease_expires_at = NULL,
            revision = revision + 1,
            updated_at = $5
      WHERE business_id = $1
        AND integration_id = $2
        AND integration_major_version = $3
        AND connection_id = $4`,
    [
      input.businessId,
      input.integrationId,
      input.integrationMajorVersion,
      input.connectionId,
      input.deletedAt,
    ]
  );
  const updated = await transaction.query<{ source_id: string }>(
    `UPDATE knowledge_source_records
        SET status = 'deleted',
            verification = 'unverifiable',
            revision = $5 || ':' || source_id,
            acl_revision = NULL,
            acl_captured_at = NULL,
            acl_principals = NULL,
            last_synced_at = $6,
            provenance_captured_at = $6,
            updated_at = now()
      WHERE business_id = $1
        AND integration_id = $2
        AND provenance_integration_major_version = $3
        AND provenance_connection_id = $4
        AND source_locator ->> 'kind' = 'oim'
      RETURNING source_id`,
    [
      input.businessId,
      input.integrationId,
      input.integrationMajorVersion,
      input.connectionId,
      input.deletedRevisionPrefix,
      input.deletedAt,
    ]
  );
  const sourceIds = updated.rows.map(({ source_id }) => source_id).sort();
  if (sourceIds.length > 0) {
    await transaction.query(
      `DELETE FROM knowledge_source_chunks
        WHERE business_id = $1 AND source_id = ANY($2::text[])`,
      [input.businessId, sourceIds]
    );
  }
  return sourceIds;
}

interface ConnectionFenceRow {
  generation: number | string;
  status: "active" | "blocked";
  external_tenant_id: string | null;
  external_account_id: string | null;
}

async function captureConnectionFence(
  transaction: Queryable,
  input: OimKnowledgeConnectionFenceScope,
  recoverBlocked: boolean
): Promise<OimKnowledgeConnectionFenceClaim | null> {
  const connection = await transaction.query(
    `SELECT id
       FROM connections
      WHERE business_id = $1
        AND id = $2
        AND integration_id = $3
        AND integration_major_version = $4
        AND status = 'active'
        AND health_status <> 'action_required'
        AND (expires_at IS NULL OR expires_at > now())
      FOR UPDATE`,
    [input.businessId, input.connectionId, input.integrationId, input.integrationMajorVersion]
  );
  if (connection.rows.length !== 1) return null;

  const identity = await transaction.query(
    `SELECT connection_id
       FROM connection_external_identities
      WHERE business_id = $1
        AND connection_id = $2
        AND integration_id = $3
        AND integration_major_version = $4
        AND external_tenant_id = $5
        AND external_account_id = $6
      FOR UPDATE`,
    [
      input.businessId,
      input.connectionId,
      input.integrationId,
      input.integrationMajorVersion,
      input.externalTenantId,
      input.externalAccountId,
    ]
  );
  if (identity.rows.length !== 1) return null;

  const existing = await transaction.query<ConnectionFenceRow>(
    `SELECT generation, status, external_tenant_id, external_account_id
       FROM oim_knowledge_connection_fences
      WHERE business_id = $1
        AND integration_id = $2
        AND integration_major_version = $3
        AND connection_id = $4
      FOR UPDATE`,
    [input.businessId, input.integrationId, input.integrationMajorVersion, input.connectionId]
  );
  const row = existing.rows[0];
  if (row === undefined) {
    const inserted = await transaction.query<ConnectionFenceRow>(
      `INSERT INTO oim_knowledge_connection_fences (
         business_id, integration_id, integration_major_version, connection_id,
         generation, status, external_tenant_id, external_account_id
       ) VALUES ($1, $2, $3, $4, 1, 'active', $5, $6)
       RETURNING generation, status, external_tenant_id, external_account_id`,
      [
        input.businessId,
        input.integrationId,
        input.integrationMajorVersion,
        input.connectionId,
        input.externalTenantId,
        input.externalAccountId,
      ]
    );
    return claimFromFence(input, inserted.rows[0]);
  }
  if (row.status === "active") {
    if (
      row.external_tenant_id !== input.externalTenantId ||
      row.external_account_id !== input.externalAccountId
    ) {
      return null;
    }
    return claimFromFence(input, row);
  }
  if (!recoverBlocked) return null;
  const recovered = await transaction.query<ConnectionFenceRow>(
    `UPDATE oim_knowledge_connection_fences
        SET generation = generation + 1,
            status = 'active',
            external_tenant_id = COALESCE(external_tenant_id, $5),
            external_account_id = COALESCE(external_account_id, $6),
            updated_at = now()
      WHERE business_id = $1
        AND integration_id = $2
        AND integration_major_version = $3
        AND connection_id = $4
        AND status = 'blocked'
        AND (external_tenant_id IS NULL OR external_tenant_id = $5)
        AND (external_account_id IS NULL OR external_account_id = $6)
      RETURNING generation, status, external_tenant_id, external_account_id`,
    [
      input.businessId,
      input.integrationId,
      input.integrationMajorVersion,
      input.connectionId,
      input.externalTenantId,
      input.externalAccountId,
    ]
  );
  return claimFromFence(input, recovered.rows[0]);
}

function claimFromFence(
  input: OimKnowledgeConnectionFenceScope,
  row: ConnectionFenceRow | undefined
): OimKnowledgeConnectionFenceClaim | null {
  return row === undefined
    ? null
    : {
        ...input,
        connectionGeneration: Number(row.generation),
      };
}

async function publicationClaimIsCurrent(
  transaction: Queryable,
  claim: OimKnowledgePublicationClaim | undefined
): Promise<boolean> {
  if (claim === undefined) return false;
  const connection = await transaction.query(
    `SELECT id
       FROM connections
      WHERE business_id = $1
        AND id = $2
        AND integration_id = $3
        AND integration_major_version = $4
        AND status = 'active'
        AND health_status <> 'action_required'
        AND (expires_at IS NULL OR expires_at > now())
      FOR UPDATE`,
    [claim.businessId, claim.connectionId, claim.integrationId, claim.integrationMajorVersion]
  );
  if (connection.rows.length !== 1) return false;

  const identity = await transaction.query(
    `SELECT connection_id
       FROM connection_external_identities
      WHERE business_id = $1
        AND connection_id = $2
        AND integration_id = $3
        AND integration_major_version = $4
        AND external_tenant_id = $5
        AND external_account_id = $6
      FOR UPDATE`,
    [
      claim.businessId,
      claim.connectionId,
      claim.integrationId,
      claim.integrationMajorVersion,
      claim.externalTenantId,
      claim.externalAccountId,
    ]
  );
  if (identity.rows.length !== 1) return false;

  const fence = await transaction.query(
    `SELECT connection_id
       FROM oim_knowledge_connection_fences
      WHERE business_id = $1
        AND integration_id = $2
        AND integration_major_version = $3
        AND connection_id = $4
        AND generation = $5
        AND status = 'active'
        AND external_tenant_id = $6
        AND external_account_id = $7
      FOR UPDATE`,
    [
      claim.businessId,
      claim.integrationId,
      claim.integrationMajorVersion,
      claim.connectionId,
      claim.connectionGeneration,
      claim.externalTenantId,
      claim.externalAccountId,
    ]
  );
  if (fence.rows.length !== 1) return false;

  const checkpoint = await transaction.query(
    `SELECT scope_key
       FROM oim_knowledge_scan_checkpoints
      WHERE business_id = $1
        AND integration_id = $2
        AND integration_major_version = $3
        AND connection_id = $4
        AND source_kind = $5
        AND scope_key = $6
        AND scan_id = $7
        AND lease_token = $8
        AND revision = $9
        AND lease_expires_at > now()
      FOR UPDATE`,
    [
      claim.businessId,
      claim.integrationId,
      claim.integrationMajorVersion,
      claim.connectionId,
      claim.sourceKindId,
      claim.scope,
      claim.scanId,
      claim.leaseToken,
      claim.checkpointRevision,
    ]
  );
  return checkpoint.rows.length === 1;
}

function assertConnectionFenceScope(input: OimKnowledgeConnectionFenceScope): void {
  if (
    input.businessId.length === 0 ||
    input.integrationId.length === 0 ||
    !Number.isSafeInteger(input.integrationMajorVersion) ||
    input.integrationMajorVersion < 0 ||
    input.connectionId.length === 0 ||
    input.externalTenantId.length === 0 ||
    input.externalAccountId.length === 0
  ) {
    throw new Error("invalid_oim_knowledge_connection_fence");
  }
}

function assertExactScope(
  input: QuarantineOimKnowledgeScope | TombstoneOimKnowledgeConnection
): void {
  const invalidOperation =
    "sourceKindId" in input
      ? input.sourceKindId.length === 0 ||
        input.scope.length === 0 ||
        input.quarantinedRevisionPrefix.length === 0 ||
        !Number.isFinite(new Date(input.quarantinedAt).getTime()) ||
        input.businessId !== input.claim.businessId ||
        input.integrationId !== input.claim.integrationId ||
        input.integrationMajorVersion !== input.claim.integrationMajorVersion ||
        input.connectionId !== input.claim.connectionId ||
        input.sourceKindId !== input.claim.sourceKindId ||
        input.scope !== input.claim.scope
      : input.deletedRevisionPrefix.length === 0 ||
        !Number.isFinite(new Date(input.deletedAt).getTime());
  if (
    input.businessId.length === 0 ||
    input.integrationId.length === 0 ||
    !Number.isSafeInteger(input.integrationMajorVersion) ||
    input.integrationMajorVersion < 0 ||
    input.connectionId.length === 0 ||
    invalidOperation
  ) {
    throw new Error("invalid_oim_knowledge_scope");
  }
}
