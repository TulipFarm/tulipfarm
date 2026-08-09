import type {
  ConfluenceSyncCheckpoint,
  ConfluenceSyncCheckpointStore,
} from "@tulipfarm/integrations";
import type { Queryable } from "../db";

interface CheckpointRow {
  integration_id: string;
  cursor: string | null;
  updated_at: string;
}

/** Postgres storage for `ConfluenceSyncCheckpointStore` (`confluence_knowledge_checkpoints`). */
export class PgConfluenceKnowledgeCheckpointStore implements ConfluenceSyncCheckpointStore {
  constructor(private readonly q: Queryable) {}

  async load(integrationId: string): Promise<ConfluenceSyncCheckpoint | undefined> {
    const { rows } = await this.q.query(
      "SELECT integration_id, cursor, updated_at FROM confluence_knowledge_checkpoints " +
        "WHERE integration_id = $1",
      [integrationId]
    );
    const row = rows[0] as unknown as CheckpointRow | undefined;
    if (!row) return undefined;
    return {
      integrationId: row.integration_id,
      ...(row.cursor === null ? {} : { cursor: row.cursor }),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async save(checkpoint: ConfluenceSyncCheckpoint): Promise<void> {
    await this.q.query(
      `INSERT INTO confluence_knowledge_checkpoints (integration_id, cursor, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (integration_id) DO UPDATE SET
         cursor = EXCLUDED.cursor,
         updated_at = EXCLUDED.updated_at`,
      [checkpoint.integrationId, checkpoint.cursor ?? null, checkpoint.updatedAt]
    );
  }
}
