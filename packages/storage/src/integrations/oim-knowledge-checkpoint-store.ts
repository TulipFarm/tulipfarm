import type { TransactionPort } from "../ports";

export interface OimKnowledgeCheckpointKey {
  readonly businessId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
  readonly sourceKind: string;
  readonly scope: string;
}

export interface OimKnowledgeCheckpoint extends OimKnowledgeCheckpointKey {
  readonly baselineItemIds: readonly string[];
  readonly scanId: string | null;
  readonly continuation: string | null;
  readonly accumulatedSeenItemIds: readonly string[];
  readonly pendingDeletionItemIds: readonly string[];
  readonly revision: number;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly updatedAt: string;
}

export const OIM_KNOWLEDGE_CHECKPOINT_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS oim_knowledge_scan_checkpoints (
    business_id                 text NOT NULL,
    integration_id              text NOT NULL,
    integration_major_version   integer NOT NULL CHECK (integration_major_version >= 0),
    connection_id               text NOT NULL,
    source_kind                 text NOT NULL,
    scope_key                   text NOT NULL,
    baseline_item_ids           jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (jsonb_typeof(baseline_item_ids) = 'array'),
    scan_id                     text,
    continuation                text,
    accumulated_seen_item_ids   jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (jsonb_typeof(accumulated_seen_item_ids) = 'array'),
    pending_deletion_item_ids   jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (jsonb_typeof(pending_deletion_item_ids) = 'array'),
    revision                    bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    lease_token                 text,
    lease_expires_at            timestamptz,
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
      business_id,
      integration_id,
      integration_major_version,
      connection_id,
      source_kind,
      scope_key
    ),
    FOREIGN KEY (
      business_id, connection_id, integration_id, integration_major_version
    ) REFERENCES connections (
      business_id, id, integration_id, integration_major_version
    ) ON DELETE CASCADE,
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CHECK (
      scan_id IS NOT NULL
      OR (
        continuation IS NULL
        AND accumulated_seen_item_ids = '[]'::jsonb
        AND pending_deletion_item_ids = '[]'::jsonb
      )
    )
  )`,
  `CREATE INDEX IF NOT EXISTS oim_knowledge_scan_lease_idx
     ON oim_knowledge_scan_checkpoints (lease_expires_at)
     WHERE lease_token IS NOT NULL`,
];

interface CheckpointRow {
  business_id: string;
  integration_id: string;
  integration_major_version: number;
  connection_id: string;
  source_kind: string;
  scope_key: string;
  baseline_item_ids: unknown;
  scan_id: string | null;
  continuation: string | null;
  accumulated_seen_item_ids: unknown;
  pending_deletion_item_ids: unknown;
  revision: number | string;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  updated_at: Date | string;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("invalid_oim_knowledge_checkpoint");
  }
  return value;
}

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function fromRow(row: CheckpointRow): OimKnowledgeCheckpoint {
  return {
    businessId: row.business_id,
    integrationId: row.integration_id,
    integrationMajorVersion: row.integration_major_version,
    connectionId: row.connection_id,
    sourceKind: row.source_kind,
    scope: row.scope_key,
    baselineItemIds: strings(row.baseline_item_ids),
    scanId: row.scan_id,
    continuation: row.continuation,
    accumulatedSeenItemIds: strings(row.accumulated_seen_item_ids),
    pendingDeletionItemIds: strings(row.pending_deletion_item_ids),
    revision: Number(row.revision),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at === null ? null : timestamp(row.lease_expires_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function keyParams(key: OimKnowledgeCheckpointKey): readonly unknown[] {
  return [
    key.businessId,
    key.integrationId,
    key.integrationMajorVersion,
    key.connectionId,
    key.sourceKind,
    key.scope,
  ];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class OimKnowledgeCheckpointStore {
  constructor(private readonly transactions: TransactionPort) {}

  async load(key: OimKnowledgeCheckpointKey): Promise<OimKnowledgeCheckpoint | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<CheckpointRow>(
        `SELECT * FROM oim_knowledge_scan_checkpoints
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id = $4
            AND source_kind = $5
            AND scope_key = $6`,
        keyParams(key)
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }

  async claim(
    key: OimKnowledgeCheckpointKey,
    scanId: string,
    leaseToken: string,
    leaseSeconds: number,
    now = new Date()
  ): Promise<OimKnowledgeCheckpoint | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<CheckpointRow>(
        `INSERT INTO oim_knowledge_scan_checkpoints (
           business_id, integration_id, integration_major_version, connection_id,
           source_kind, scope_key, scan_id, lease_token, lease_expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz + make_interval(secs => $10))
         ON CONFLICT (
           business_id, integration_id, integration_major_version, connection_id,
           source_kind, scope_key
         ) DO UPDATE SET
           scan_id = CASE
             WHEN oim_knowledge_scan_checkpoints.scan_id IS NULL THEN EXCLUDED.scan_id
             ELSE oim_knowledge_scan_checkpoints.scan_id
           END,
           lease_token = EXCLUDED.lease_token,
           lease_expires_at = EXCLUDED.lease_expires_at,
           revision = oim_knowledge_scan_checkpoints.revision + 1,
           updated_at = $9
         WHERE (
           oim_knowledge_scan_checkpoints.lease_expires_at IS NULL
           OR oim_knowledge_scan_checkpoints.lease_expires_at <= $9
         )
           AND (
             oim_knowledge_scan_checkpoints.scan_id IS NULL
             OR oim_knowledge_scan_checkpoints.scan_id = EXCLUDED.scan_id
           )
         RETURNING *`,
        [...keyParams(key), scanId, leaseToken, now, leaseSeconds]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }

  async appendPage(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    continuation: string | null,
    seenItemIds: readonly string[],
    now = new Date()
  ): Promise<OimKnowledgeCheckpoint | null> {
    const page = unique(seenItemIds);
    return this.update(
      key,
      leaseToken,
      expectedRevision,
      `continuation = $10,
       accumulated_seen_item_ids = (
         SELECT COALESCE(jsonb_agg(item ORDER BY item), '[]'::jsonb)
           FROM (
             SELECT DISTINCT jsonb_array_elements_text(
               accumulated_seen_item_ids || $11::jsonb
             ) AS item
           ) seen
       )`,
      [continuation, JSON.stringify(page)],
      now
    );
  }

  async stageCompletion(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    pendingDeletionItemIds: readonly string[],
    now = new Date()
  ): Promise<OimKnowledgeCheckpoint | null> {
    return this.update(
      key,
      leaseToken,
      expectedRevision,
      "continuation = NULL, pending_deletion_item_ids = $10::jsonb",
      [JSON.stringify(unique(pendingDeletionItemIds))],
      now
    );
  }

  async acknowledgeDeletions(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    deletedItemIds: readonly string[],
    now = new Date()
  ): Promise<OimKnowledgeCheckpoint | null> {
    return this.update(
      key,
      leaseToken,
      expectedRevision,
      `pending_deletion_item_ids = (
         SELECT COALESCE(jsonb_agg(item ORDER BY item), '[]'::jsonb)
           FROM jsonb_array_elements_text(pending_deletion_item_ids) item
          WHERE NOT (item = ANY($10::text[]))
       )`,
      [unique(deletedItemIds)],
      now
    );
  }

  async complete(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    now = new Date()
  ): Promise<OimKnowledgeCheckpoint | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<CheckpointRow>(
        `UPDATE oim_knowledge_scan_checkpoints
            SET baseline_item_ids = accumulated_seen_item_ids,
                scan_id = NULL,
                continuation = NULL,
                accumulated_seen_item_ids = '[]'::jsonb,
                pending_deletion_item_ids = '[]'::jsonb,
                lease_token = NULL,
                lease_expires_at = NULL,
                revision = revision + 1,
                updated_at = $9
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id = $4
            AND source_kind = $5
            AND scope_key = $6
            AND lease_token = $7
            AND revision = $8
            AND lease_expires_at > $9
            AND scan_id IS NOT NULL
            AND continuation IS NULL
            AND pending_deletion_item_ids = '[]'::jsonb
          RETURNING *`,
        [...keyParams(key), leaseToken, expectedRevision, now]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }

  async release(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    now = new Date()
  ): Promise<OimKnowledgeCheckpoint | null> {
    return this.update(
      key,
      leaseToken,
      expectedRevision,
      "lease_token = NULL, lease_expires_at = NULL",
      [],
      now
    );
  }

  private async update(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    assignments: string,
    extraParams: readonly unknown[],
    now: Date
  ): Promise<OimKnowledgeCheckpoint | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<CheckpointRow>(
        `UPDATE oim_knowledge_scan_checkpoints
            SET ${assignments}, revision = revision + 1, updated_at = $9
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id = $4
            AND source_kind = $5
            AND scope_key = $6
            AND lease_token = $7
            AND revision = $8
            AND lease_expires_at > $9
          RETURNING *`,
        [...keyParams(key), leaseToken, expectedRevision, now, ...extraParams]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }
}
