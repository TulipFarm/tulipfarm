import { MAX_KEY_CHARS, MAX_VALUE_CHARS } from "./limits";

/** Per-user Memory Assertion; `lastWrittenAt` is the LRU key because reads load all entries. */
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

/** Hard write-time invariant guard; oversize rejection is handled by caller-facing policy. */
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
