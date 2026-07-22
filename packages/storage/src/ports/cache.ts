/**
 * Provider-neutral ephemeral cache port.
 *
 * Capability id `cache` (optional accelerator — see `@tulipfarm/observability`
 * capability catalog). Redis is one adapter. Losing the cache cannot lose
 * authoritative state or violate a limit (invariant 16); values are advisory
 * copies of data the correctness core still owns.
 */

export interface CachePort {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}
