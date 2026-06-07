import type { Collection, Db } from "mongodb";
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

export class MongoWorkingMemoryRepo implements WorkingMemoryRepo {
  private readonly collection: Collection<WorkingMemoryDoc>;

  constructor(db: Db) {
    this.collection = db.collection<WorkingMemoryDoc>("working_memory");
  }

  async upsert(doc: WorkingMemoryDoc): Promise<void> {
    assertValidEntry(doc);
    // Filter on {userId,key} (the unique index); the service supplies the existing _id on update,
    // so the immutable _id never changes under us.
    await this.collection.replaceOne({ userId: doc.userId, key: doc.key }, doc, { upsert: true });
  }

  async deleteByKey(userId: string, key: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ userId, key });
    return result.deletedCount > 0;
  }

  listByUser(userId: string): Promise<WorkingMemoryDoc[]> {
    return this.collection.find({ userId }).sort({ lastWrittenAt: 1 }).toArray();
  }
}
