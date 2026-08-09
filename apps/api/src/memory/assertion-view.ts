import { MAX_KEY_CHARS, MAX_VALUE_CHARS } from "./limits";

/**
 * One per-user Memory Assertion (MEM-V1-002). Keyed per user (tenant-wide) so personal facts
 * follow the user across agents. `lastWrittenAt` is the LRU key: it advances on every write
 * (memory is read in full each turn, so read-recency is meaningless — recency means last write).
 */
export interface MemoryAssertionView {
  _id: string;
  userId: string;
  key: string;
  value: string;
  writtenByAgentId?: string;
  createdAt: Date;
  lastWrittenAt: Date;
}

export class InvalidMemoryAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMemoryAssertionError";
  }
}

/**
 * Write-time guard, mirroring `assertValidMessage` — no document that breaks the per-entry
 * invariants ever reaches the collection. (Oversize *rejection toward knowledge* is a softer,
 * caller-facing policy handled in the service; this is the hard floor.)
 */
export function assertValidAssertion(doc: MemoryAssertionView): void {
  if (!doc.userId) {
    throw new InvalidMemoryAssertionError("Memory Assertion requires a userId");
  }
  if (!doc.key) {
    throw new InvalidMemoryAssertionError("Memory Assertion requires a non-empty key");
  }
  if (doc.key.length > MAX_KEY_CHARS) {
    throw new InvalidMemoryAssertionError(
      `Memory Assertion key exceeds ${MAX_KEY_CHARS} characters`
    );
  }
  if (doc.value.length > MAX_VALUE_CHARS) {
    throw new InvalidMemoryAssertionError(
      `Memory Assertion value exceeds ${MAX_VALUE_CHARS} characters`
    );
  }
}

export interface MemoryRepo {
  upsert(doc: MemoryAssertionView): Promise<void>;
  deleteByKey(userId: string, key: string): Promise<boolean>;
  /** A user's entries, oldest-written first (the order LRU eviction consumes). */
  listByUser(userId: string): Promise<MemoryAssertionView[]>;
}
