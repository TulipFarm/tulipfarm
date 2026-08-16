import type { BundleVerifier, RuntimeBundle } from "./bundle";

/**
 * Runtime reads are hot, while bundles are immutable. 128 verified bundles covers normal recent
 * authoring churn without letting auto-publish create an unbounded process-memory cache.
 */
export const VERIFIED_RUNTIME_BUNDLE_CACHE_MAX_ENTRIES = 128;

export interface RuntimeBundleVerificationCache {
  get(digest: string, verifier: BundleVerifier): RuntimeBundle | undefined;
  set(digest: string, verifier: BundleVerifier, bundle: RuntimeBundle): void;
}

export class LruRuntimeBundleVerificationCache implements RuntimeBundleVerificationCache {
  private readonly entries = new Map<string, RuntimeBundle>();
  private readonly verifierIds = new WeakMap<BundleVerifier, string>();
  private nextVerifierId = 1;
  private readonly maxEntries: number;

  constructor(maxEntries = VERIFIED_RUNTIME_BUNDLE_CACHE_MAX_ENTRIES) {
    this.maxEntries = Math.max(0, Math.trunc(maxEntries));
  }

  get(digest: string, verifier: BundleVerifier): RuntimeBundle | undefined {
    const key = this.cacheKey(digest, verifier);
    const cached = this.entries.get(key);
    if (cached === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached;
  }

  set(digest: string, verifier: BundleVerifier, bundle: RuntimeBundle): void {
    if (this.maxEntries === 0) return;
    const key = this.cacheKey(digest, verifier);
    this.entries.delete(key);
    this.entries.set(key, bundle);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }

  private cacheKey(digest: string, verifier: BundleVerifier): string {
    // Digest alone is unsafe across verifier rotation: a digest verified by an old trust set must
    // not bypass a new verifier that has removed or replaced a key.
    const verifierId = this.verifierId(verifier);
    return `${verifierId}\u0000${verifier.trustedKeyIds.join("\u0000")}\u0000${digest}`;
  }

  private verifierId(verifier: BundleVerifier): string {
    const existing = this.verifierIds.get(verifier);
    if (existing !== undefined) return existing;
    const next = `verifier-${this.nextVerifierId}`;
    this.nextVerifierId += 1;
    this.verifierIds.set(verifier, next);
    return next;
  }
}
