import type {
  SlackKnowledgeCheckpoint,
  SlackKnowledgeCheckpointStore,
} from "@tulipfarm/integrations";
import type { Queryable } from "../db";

interface CheckpointRow {
  integration_id: string;
  channel_id: string;
  cursor: string | null;
  updated_at: string;
}

/** Postgres storage for `SlackKnowledgeCheckpointStore` (`slack_knowledge_checkpoints`). */
export class PgSlackKnowledgeCheckpointStore implements SlackKnowledgeCheckpointStore {
  constructor(private readonly q: Queryable) {}

  async load(
    integrationId: string,
    channelId: string
  ): Promise<SlackKnowledgeCheckpoint | undefined> {
    const { rows } = await this.q.query(
      "SELECT integration_id, channel_id, cursor, updated_at FROM slack_knowledge_checkpoints " +
        "WHERE integration_id = $1 AND channel_id = $2",
      [integrationId, channelId]
    );
    const row = rows[0] as unknown as CheckpointRow | undefined;
    if (!row) return undefined;
    return {
      integrationId: row.integration_id,
      channelId: row.channel_id,
      ...(row.cursor === null ? {} : { cursor: row.cursor }),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async save(checkpoint: SlackKnowledgeCheckpoint): Promise<void> {
    await this.q.query(
      `INSERT INTO slack_knowledge_checkpoints (integration_id, channel_id, cursor, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (integration_id, channel_id) DO UPDATE SET
         cursor = EXCLUDED.cursor,
         updated_at = EXCLUDED.updated_at`,
      [
        checkpoint.integrationId,
        checkpoint.channelId,
        checkpoint.cursor ?? null,
        checkpoint.updatedAt,
      ]
    );
  }
}
