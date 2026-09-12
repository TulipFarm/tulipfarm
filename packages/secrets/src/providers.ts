/** Secret providers keep legacy freshness policy and expose uncached reads for pinned leases. */

import { secretStorageKey } from "./connection-secrets";
import type { SecretsService } from "./encrypted-store";
import { SecretUnavailableError } from "./encrypted-store";

export interface ResolvedSecret {
  readonly value: string;
  /** Opaque rotation marker, safe to log and not value-derived. */
  readonly version?: string;
}

export interface SecretProvider {
  /** Plaintext using the provider's normal cache/freshness policy. */
  resolveCurrent(secretRef: string): Promise<ResolvedSecret | null>;
  /** Durable plaintext bypassing caches. Required for revision-pinned Connection leases. */
  resolveUncached?(secretRef: string): Promise<ResolvedSecret | null>;
  /** Durable revision without plaintext. Required for Connection leases. */
  currentVersion?(secretRef: string): Promise<string | null>;
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
    async resolveUncached(secretRef) {
      const value = values.get(secretRef);
      if (value === undefined) {
        return null;
      }
      return { value, version: String(versions.get(secretRef) ?? 1) };
    },
    async currentVersion(secretRef) {
      const version = versions.get(secretRef);
      return version === undefined ? null : String(version);
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

/** Preserves legacy cache semantics while exposing uncached reads for Connection leases. */
export function secretsServiceProvider(
  service: Pick<SecretsService, "get"> &
    Partial<Pick<SecretsService, "resolveCurrent" | "revision">>
): SecretProvider {
  const resolveUncached = service.resolveCurrent?.bind(service);
  const currentVersion = service.revision?.bind(service);
  const keyFor = (secretRef: string) =>
    secretRef.startsWith("secret://") ? secretStorageKey(secretRef) : secretRef;
  const provider: SecretProvider = {
    async resolveCurrent(secretRef) {
      try {
        return { value: await service.get(keyFor(secretRef)) };
      } catch (error) {
        if (error instanceof SecretUnavailableError) {
          return null;
        }
        throw error;
      }
    },
  };
  return {
    ...provider,
    ...(resolveUncached === undefined
      ? {}
      : {
          async resolveUncached(secretRef: string) {
            try {
              return await resolveUncached(keyFor(secretRef));
            } catch (error) {
              if (error instanceof SecretUnavailableError) {
                return null;
              }
              throw error;
            }
          },
        }),
    ...(currentVersion === undefined
      ? {}
      : {
          async currentVersion(secretRef: string) {
            return await currentVersion(keyFor(secretRef));
          },
        }),
  };
}
