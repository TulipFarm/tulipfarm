import type {
  KnowledgeAccessControl,
  KnowledgeAclSnapshot,
  KnowledgePrincipalRef,
  KnowledgeSourceRecord,
  MutableKnowledgeSourceStore,
} from "@tulipfarm/knowledge";
import type { Queryable } from "../db";

interface KnowledgeSourceRow {
  source_id: string;
  business_id: string;
  integration_id: string;
  provider: string;
  external_id: string;
  external_tenant_id: string;
  owner_external_id: string;
  revision: string;
  classification: string[];
  status: string;
  verification: string;
  access_control_mode: string;
  access_control_max_age_seconds: number;
  acl_revision: string | null;
  acl_captured_at: Date | null;
  acl_principals: KnowledgePrincipalRef[] | null;
  provenance_captured_at: Date;
  provenance_content_hash: string;
  provenance_checkpoint: string | null;
  last_synced_at: Date;
}

function accessControlFromRow(row: KnowledgeSourceRow): KnowledgeAccessControl {
  if (row.access_control_mode === "snapshot") {
    return {
      mode: "snapshot",
      // Snapshot mode always carries an aclRevision (enforced on write); empty string only if the
      // column is unexpectedly null, which keeps the shape well-typed rather than throwing here.
      aclRevision: row.acl_revision ?? "",
      maximumAgeSeconds: row.access_control_max_age_seconds,
    };
  }
  return { mode: "live", maximumAgeSeconds: row.access_control_max_age_seconds };
}

function aclFromRow(row: KnowledgeSourceRow): KnowledgeAclSnapshot | undefined {
  if (row.acl_revision === null || row.acl_captured_at === null || row.acl_principals === null) {
    return undefined;
  }
  return {
    aclRevision: row.acl_revision,
    capturedAt: row.acl_captured_at.toISOString(),
    principals: row.acl_principals,
  };
}

function rowToRecord(row: KnowledgeSourceRow): KnowledgeSourceRecord {
  const acl = aclFromRow(row);
  return {
    sourceId: row.source_id,
    businessId: row.business_id,
    integrationId: row.integration_id,
    provider: row.provider,
    externalId: row.external_id,
    externalTenantId: row.external_tenant_id,
    ownerExternalId: row.owner_external_id,
    revision: row.revision,
    classification: row.classification,
    status: row.status as KnowledgeSourceRecord["status"],
    verification: row.verification as KnowledgeSourceRecord["verification"],
    accessControl: accessControlFromRow(row),
    ...(acl === undefined ? {} : { acl }),
    provenance: {
      capturedAt: row.provenance_captured_at.toISOString(),
      contentHash: row.provenance_content_hash,
      ...(row.provenance_checkpoint === null ? {} : { checkpoint: row.provenance_checkpoint }),
    },
    lastSyncedAt: row.last_synced_at.toISOString(),
  };
}

/**
 * Postgres storage for `KnowledgeSourceRecord` (`knowledge_source_records`). `retrieve()` reads
 * through `list`/`get` to build its authorized set before any candidate is ranked — this store
 * has no filtering of its own, `acl.ts` owns that decision.
 */
export class PgKnowledgeSourceStore implements MutableKnowledgeSourceStore {
  constructor(private readonly q: Queryable) {}

  async list(businessId: string): Promise<readonly KnowledgeSourceRecord[]> {
    const { rows } = await this.q.query(
      "SELECT * FROM knowledge_source_records WHERE business_id = $1",
      [businessId]
    );
    return (rows as unknown as KnowledgeSourceRow[]).map(rowToRecord);
  }

  async get(businessId: string, sourceId: string): Promise<KnowledgeSourceRecord | undefined> {
    const { rows } = await this.q.query(
      "SELECT * FROM knowledge_source_records WHERE business_id = $1 AND source_id = $2",
      [businessId, sourceId]
    );
    return rows.length > 0 ? rowToRecord(rows[0] as unknown as KnowledgeSourceRow) : undefined;
  }

  async put(record: KnowledgeSourceRecord): Promise<void> {
    const acl = record.accessControl.mode === "snapshot" ? record.acl : undefined;
    await this.q.query(
      `INSERT INTO knowledge_source_records
         (source_id, business_id, integration_id, provider, external_id, external_tenant_id,
          owner_external_id, revision, classification, status, verification,
          access_control_mode, access_control_max_age_seconds, acl_revision, acl_captured_at,
          acl_principals, provenance_captured_at, provenance_content_hash, provenance_checkpoint,
          last_synced_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,
               $20,now(),now())
       ON CONFLICT (business_id, source_id) DO UPDATE SET
         integration_id = EXCLUDED.integration_id,
         provider = EXCLUDED.provider,
         external_id = EXCLUDED.external_id,
         external_tenant_id = EXCLUDED.external_tenant_id,
         owner_external_id = EXCLUDED.owner_external_id,
         revision = EXCLUDED.revision,
         classification = EXCLUDED.classification,
         status = EXCLUDED.status,
         verification = EXCLUDED.verification,
         access_control_mode = EXCLUDED.access_control_mode,
         access_control_max_age_seconds = EXCLUDED.access_control_max_age_seconds,
         acl_revision = EXCLUDED.acl_revision,
         acl_captured_at = EXCLUDED.acl_captured_at,
         acl_principals = EXCLUDED.acl_principals,
         provenance_captured_at = EXCLUDED.provenance_captured_at,
         provenance_content_hash = EXCLUDED.provenance_content_hash,
         provenance_checkpoint = EXCLUDED.provenance_checkpoint,
         last_synced_at = EXCLUDED.last_synced_at,
         updated_at = now()`,
      [
        record.sourceId,
        record.businessId,
        record.integrationId,
        record.provider,
        record.externalId,
        record.externalTenantId,
        record.ownerExternalId,
        record.revision,
        record.classification,
        record.status,
        record.verification,
        record.accessControl.mode,
        record.accessControl.maximumAgeSeconds,
        acl?.aclRevision ?? null,
        acl?.capturedAt ?? null,
        acl === undefined ? null : JSON.stringify(acl.principals),
        record.provenance.capturedAt,
        record.provenance.contentHash,
        record.provenance.checkpoint ?? null,
        record.lastSyncedAt,
      ]
    );
  }
}
