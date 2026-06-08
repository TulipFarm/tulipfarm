import type { Queryable } from "../db";
import { MAX_KEY_CHARS, MAX_VALUE_CHARS } from "./limits";

/**
 * One per-user working-memory fact (MEM-V1-002). Keyed per user (tenant-wide) so personal facts
 * follow the user across agents. `lastWrittenAt` is the LRU key: it advances on every write
 * (memory is read in full each turn, so read-recency is meaningless — recency means last write).
 */
export interface WorkingMemoryDoc {
  _id: string;
  userId: string;
  key: string;
  value: string;
  writtenByAgentId?: string;
  createdAt: Date;
  lastWrittenAt: Date;
}

export class InvalidMemoryEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMemoryEntryError";
  }
}

/**
 * Write-time guard, mirroring `assertValidMessage` — no document that breaks the per-entry
 * invariants ever reaches the collection. (Oversize *rejection toward knowledge* is a softer,
 * caller-facing policy handled in the service; this is the hard floor.)
 */
export function assertValidEntry(doc: WorkingMemoryDoc): void {
  if (!doc.userId) {
    throw new InvalidMemoryEntryError("working memory entry requires a userId");
  }
  if (!doc.key) {
    throw new InvalidMemoryEntryError("working memory entry requires a non-empty key");
  }
  if (doc.key.length > MAX_KEY_CHARS) {
    throw new InvalidMemoryEntryError(`working memory key exceeds ${MAX_KEY_CHARS} characters`);
  }
  if (doc.value.length > MAX_VALUE_CHARS) {
    throw new InvalidMemoryEntryError(`working memory value exceeds ${MAX_VALUE_CHARS} characters`);
  }
}

export interface WorkingMemoryRepo {
  upsert(doc: WorkingMemoryDoc): Promise<void>;
  deleteByKey(userId: string, key: string): Promise<boolean>;
  /** A user's entries, oldest-written first (the order LRU eviction consumes). */
  listByUser(userId: string): Promise<WorkingMemoryDoc[]>;
}

function rowToEntry(row: Record<string, unknown>): WorkingMemoryDoc {
  const doc: WorkingMemoryDoc = {
    // No id column under Postgres (PK is (user_id,key)); synthesize a stable, unused identifier.
    _id: `${row.user_id as string}:${row.key as string}`,
    userId: row.user_id as string,
    key: row.key as string,
    value: row.value as string,
    createdAt: row.created_at as Date,
    lastWrittenAt: row.last_written_at as Date,
  };
  if (row.written_by_agent_id != null) {
    doc.writtenByAgentId = row.written_by_agent_id as string;
  }
  return doc;
}

export class PgWorkingMemoryRepo implements WorkingMemoryRepo {
  constructor(private readonly q: Queryable) {}

  async upsert(doc: WorkingMemoryDoc): Promise<void> {
    assertValidEntry(doc);
    await this.q.query(
      `INSERT INTO working_memory (user_id, key, value, written_by_agent_id, created_at, last_written_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, key) DO UPDATE SET
         value = EXCLUDED.value,
         written_by_agent_id = EXCLUDED.written_by_agent_id,
         last_written_at = EXCLUDED.last_written_at`,
      [
        doc.userId,
        doc.key,
        doc.value,
        doc.writtenByAgentId ?? null,
        doc.createdAt,
        doc.lastWrittenAt,
      ]
    );
  }

  async deleteByKey(userId: string, key: string): Promise<boolean> {
    const { rows } = await this.q.query(
      "DELETE FROM working_memory WHERE user_id = $1 AND key = $2 RETURNING key",
      [userId, key]
    );
    return rows.length > 0;
  }

  async listByUser(userId: string): Promise<WorkingMemoryDoc[]> {
    const { rows } = await this.q.query(
      "SELECT * FROM working_memory WHERE user_id = $1 ORDER BY last_written_at",
      [userId]
    );
    return rows.map(rowToEntry);
  }
}
