/**
 * Where the Secret Broker reads a current Credential from (SPEC §13). The port is provider-neutral:
 * a PostgreSQL-backed store, a cloud KMS-fronted store, or a Vault-compatible service all satisfy
 * it, and no adapter type leaks into the broker.
 *
 * The freshness contract is the point of this boundary. `resolveCurrent` must return the value that
 * is current *at call time* and must return `null` once the Credential is revoked or deleted. An
 * adapter that serves stale plaintext defeats "rotation and revocation apply to the next
 * invocation", so caching belongs behind an explicit invalidation the adapter controls.
 */

import type { SecretsService } from "./encrypted-store";
import { SecretUnavailableError } from "./encrypted-store";

export interface ResolvedSecret {
  readonly value: string;
  /** Opaque rotation marker, when the backend has one. Safe to log; it is not derived from value. */
  readonly version?: string;
}

export interface SecretProvider {
  /** Current plaintext for `secretRef`, or `null` when it is revoked, deleted, or unknown. */
  resolveCurrent(secretRef: string): Promise<ResolvedSecret | null>;
}

export interface InMemorySecretProvider extends SecretProvider {
  set(secretRef: string, value: string): void;
  revoke(secretRef: string): void;
}

/**
 * Development and test adapter. Holds plaintext in process memory with no encryption at rest, so it
 * must never back a deployed business: it exists to exercise broker behavior deterministically.
 */
export function inMemorySecretProvider(
  initial: Readonly<Record<string, string>> = {}
): InMemorySecretProvider {
  const values = new Map<string, string>(Object.entries(initial));
  const versions = new Map<string, number>();
  for (const key of values.keys()) {
    versions.set(key, 1);
  }
  return {
    async resolveCurrent(secretRef) {
      const value = values.get(secretRef);
      if (value === undefined) {
        return null;
      }
      return { value, version: String(versions.get(secretRef) ?? 1) };
    },
    set(secretRef, value) {
      values.set(secretRef, value);
      versions.set(secretRef, (versions.get(secretRef) ?? 0) + 1);
    },
    revoke(secretRef) {
      values.delete(secretRef);
      versions.delete(secretRef);
    },
  };
}

/**
 * Adapter over {@link SecretsService}, the PostgreSQL-backed Secret store.
 *
 * `SecretsService` keeps a TTL cache of decrypted values, so this adapter is only as fresh as that
 * cache. It satisfies the freshness contract when the same service instance is the rotation and
 * revocation authority — `set` and `delete` clear the entry — which is the single-process case. A
 * deployment that rotates Secrets out of band must invalidate that cache, or resolve through an
 * uncached provider, before a lease can be trusted to see the rotation.
 */
export function secretsServiceProvider(service: Pick<SecretsService, "get">): SecretProvider {
  return {
    async resolveCurrent(secretRef) {
      try {
        return { value: await service.get(secretRef) };
      } catch (error) {
        if (error instanceof SecretUnavailableError) {
          return null;
        }
        throw error;
      }
    },
  };
}
