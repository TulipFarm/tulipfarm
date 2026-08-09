import type { Queryable } from "../db";

interface CheckpointRow {
  integration_id: string;
  provider: string;
  cursor: string | null;
  updated_at: string;
}

export interface ProviderSyncCheckpoint {
  readonly integrationId: string;
  readonly cursor?: string;
  readonly updatedAt: string;
}

/**
 * Generic Postgres checkpoint store for one-source-at-a-time Knowledge syncs. Confluence keeps its
 * v37 table for compatibility; K3 providers use this v38 table keyed by provider + integration.
 */
export class PgProviderKnowledgeCheckpointStore {
  constructor(
    private readonly q: Queryable,
    private readonly provider: string
  ) {}

  async load(integrationId: string): Promise<ProviderSyncCheckpoint | undefined> {
    const { rows } = await this.q.query(
      "SELECT provider, integration_id, cursor, updated_at FROM knowledge_sync_checkpoints " +
        "WHERE provider = $1 AND integration_id = $2",
      [this.provider, integrationId]
    );
    const row = rows[0] as unknown as CheckpointRow | undefined;
    if (!row) return undefined;
    return {
      integrationId: row.integration_id,
      ...(row.cursor === null ? {} : { cursor: row.cursor }),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async save(checkpoint: ProviderSyncCheckpoint): Promise<void> {
    await this.q.query(
      `INSERT INTO knowledge_sync_checkpoints (provider, integration_id, cursor, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, integration_id) DO UPDATE SET
         cursor = EXCLUDED.cursor,
         updated_at = EXCLUDED.updated_at`,
      [this.provider, checkpoint.integrationId, checkpoint.cursor ?? null, checkpoint.updatedAt]
    );
  }
}
