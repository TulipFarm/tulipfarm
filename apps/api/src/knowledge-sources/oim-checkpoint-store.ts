import type { OimKnowledgeCheckpoint, OimKnowledgeCheckpointStore } from "@tulipfarm/integrations";
import type { Queryable } from "../db";

interface CheckpointRow {
  integration_id: string;
  scope_key: string;
  cursor: string | null;
  seen_item_ids: unknown;
  updated_at: string;
}

function seenItemIds(raw: unknown): readonly string[] | undefined {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Postgres storage for `OimKnowledgeCheckpointStore` (`oim_knowledge_checkpoints`).
 *
 * A checkpoint is written only after the walk it describes committed, so this store never needs to
 * be transactional with the emission: at worst a crash re-reads a page the next Run already has.
 */
export class PgOimKnowledgeCheckpointStore implements OimKnowledgeCheckpointStore {
  constructor(private readonly q: Queryable) {}

  async load(integrationId: string, scopeKey: string): Promise<OimKnowledgeCheckpoint | undefined> {
    const { rows } = await this.q.query(
      "SELECT integration_id, scope_key, cursor, seen_item_ids, updated_at " +
        "FROM oim_knowledge_checkpoints WHERE integration_id = $1 AND scope_key = $2",
      [integrationId, scopeKey]
    );
    const row = rows[0] as unknown as CheckpointRow | undefined;
    if (!row) return undefined;
    const seen = seenItemIds(row.seen_item_ids);
    return {
      integrationId: row.integration_id,
      scopeKey: row.scope_key,
      ...(row.cursor === null ? {} : { cursor: row.cursor }),
      ...(seen === undefined ? {} : { seenItemIds: seen }),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async save(checkpoint: OimKnowledgeCheckpoint): Promise<void> {
    await this.q.query(
      `INSERT INTO oim_knowledge_checkpoints
         (integration_id, scope_key, cursor, seen_item_ids, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (integration_id, scope_key) DO UPDATE SET
         cursor = EXCLUDED.cursor,
         seen_item_ids = EXCLUDED.seen_item_ids,
         updated_at = EXCLUDED.updated_at`,
      [
        checkpoint.integrationId,
        checkpoint.scopeKey,
        checkpoint.cursor ?? null,
        checkpoint.seenItemIds === undefined ? null : JSON.stringify(checkpoint.seenItemIds),
        checkpoint.updatedAt,
      ]
    );
  }
}
