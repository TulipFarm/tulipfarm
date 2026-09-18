import type {
  KnowledgeAccessControl,
  KnowledgeAclSnapshot,
  KnowledgePrincipalRef,
  KnowledgeSourceRecord,
  McpKnowledgeSourceLocator,
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
  source_locator: unknown;
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

function sourceLocatorFromRow(value: unknown): McpKnowledgeSourceLocator | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const locator = value as Record<string, unknown>;
  if (
    locator.kind !== "mcp" ||
    locator.adapter !== "github-file" ||
    locator.visibility !== "personal" ||
    typeof locator.integrationId !== "string" ||
    typeof locator.accountId !== "string" ||
    typeof locator.accountRevision !== "number" ||
    !Number.isSafeInteger(locator.accountRevision) ||
    typeof locator.ownerUserId !== "string" ||
    typeof locator.externalAccountId !== "string" ||
    typeof locator.configurationRevision !== "string" ||
    typeof locator.selectionId !== "string" ||
    typeof locator.selectionRevision !== "string" ||
    typeof locator.owner !== "string" ||
    typeof locator.repo !== "string" ||
    typeof locator.path !== "string" ||
    typeof locator.ref !== "string" ||
    typeof locator.sourceUrl !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "mcp",
    adapter: "github-file",
    visibility: "personal",
    integrationId: locator.integrationId,
    accountId: locator.accountId,
    accountRevision: locator.accountRevision,
    ownerUserId: locator.ownerUserId,
    externalAccountId: locator.externalAccountId,
    configurationRevision: locator.configurationRevision,
    selectionId: locator.selectionId,
    selectionRevision: locator.selectionRevision,
    owner: locator.owner,
    repo: locator.repo,
    path: locator.path,
    ref: locator.ref,
    sourceUrl: locator.sourceUrl,
  };
}

function accessControlFromRow(row: KnowledgeSourceRow): KnowledgeAccessControl {
  if (row.access_control_mode === "snapshot") {
    return {
      mode: "snapshot",
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
  const sourceLocator = sourceLocatorFromRow(row.source_locator);
  return {
    sourceId: row.source_id,
    businessId: row.business_id,
    integrationId: row.integration_id,
    provider: row.provider,
    externalId: row.external_id,
    externalTenantId: row.external_tenant_id,
    ownerExternalId: row.owner_external_id,
    ...(sourceLocator === undefined ? {} : { sourceLocator }),
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

export class PgKnowledgeSourceStore implements MutableKnowledgeSourceStore {
  constructor(
    private readonly q: Queryable,
    private readonly mcpPublication = false
  ) {}

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

  async getMany(
    businessId: string,
    sourceIds: readonly string[]
  ): Promise<readonly KnowledgeSourceRecord[]> {
    if (sourceIds.length === 0) return [];
    const { rows } = await this.q.query(
      `SELECT * FROM knowledge_source_records
       WHERE business_id = $1 AND source_id = ANY($2::text[])`,
      [businessId, [...sourceIds]]
    );
    const byId = new Map(
      (rows as unknown as KnowledgeSourceRow[]).map((row) => [row.source_id, rowToRecord(row)])
    );
    return sourceIds.flatMap((id) => {
      const source = byId.get(id);
      return source === undefined ? [] : [source];
    });
  }

  async put(record: KnowledgeSourceRecord): Promise<void> {
    if (record.sourceLocator !== undefined && !this.mcpPublication) {
      throw new Error("mcp_knowledge_requires_atomic_publication");
    }
    const acl = record.accessControl.mode === "snapshot" ? record.acl : undefined;
    const result = await this.q.query(
      `INSERT INTO knowledge_source_records
         (source_id, business_id, integration_id, provider, external_id, external_tenant_id,
          owner_external_id, source_locator, revision, classification, status, verification,
          access_control_mode, access_control_max_age_seconds, acl_revision, acl_captured_at,
          acl_principals, provenance_captured_at, provenance_content_hash, provenance_checkpoint,
          last_synced_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::text[],$11,$12,$13,$14,$15,$16,$17::jsonb,
               $18,$19,$20,$21,now(),now())
       ON CONFLICT (business_id, source_id) DO UPDATE SET
         integration_id = EXCLUDED.integration_id,
         provider = EXCLUDED.provider,
         external_id = EXCLUDED.external_id,
         external_tenant_id = EXCLUDED.external_tenant_id,
         owner_external_id = EXCLUDED.owner_external_id,
         source_locator = EXCLUDED.source_locator,
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
         updated_at = now()
       WHERE knowledge_source_records.source_locator IS NULL OR $22
       RETURNING source_id`,
      [
        record.sourceId,
        record.businessId,
        record.integrationId,
        record.provider,
        record.externalId,
        record.externalTenantId,
        record.ownerExternalId,
        record.sourceLocator === undefined ? null : JSON.stringify(record.sourceLocator),
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
        this.mcpPublication,
      ]
    );
    if (result.rows.length !== 1) throw new Error("mcp_knowledge_requires_atomic_publication");
  }
}
