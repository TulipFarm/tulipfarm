/** Secret providers must return current plaintext at call time, or `null` after revoke/delete. */

import type { SecretsService } from "./encrypted-store";
import { SecretUnavailableError } from "./encrypted-store";

export interface ResolvedSecret {
  readonly value: string;
  /** Opaque rotation marker, safe to log and not value-derived. */
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

/** Fresh only with same-instance rotation/revocation; out-of-band changes must invalidate cache. */
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
