import type { CachePort } from "./cache";

/**
 * A process-local cache with a time bound and a size bound.
 *
 * Deliberately not shared between processes. The only thing it holds is a copy of something a
 * destination already served, so a second API instance missing what the first cached costs one
 * request and nothing else — whereas a shared cache would need every reader to agree on
 * invalidation for data none of them own. Values stay advisory: nothing here may be the only
 * record of anything.
 */

/** Entries are evicted oldest-first once this many are held, so a long Run cannot grow it. */
const DEFAULT_MAX_ENTRIES = 500;

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

export interface MemoryCacheOptions {
  readonly maxEntries?: number;
  /** Injectable so a test can expire an entry without waiting for it. */
  readonly now?: () => number;
}

export class MemoryCache implements CachePort {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-inserting moves the key to the end of the iteration order, which is what makes eviction
    // least-recently-used rather than merely oldest-written.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}
