import { isOpaqueSecretReference } from "@tulipfarm/schema";
import type { SecretBroker } from "./broker";
import { assertValidSecretKey } from "./key-guard";

const SECRET_REFERENCE_PREFIX = "secret://";

export interface MutableSecretStore {
  set(key: string, plaintext: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Maps a canonical Secret reference to its opaque storage key without deriving authority from it. */
export function secretStorageKey(secretRef: string): string {
  if (!isOpaqueSecretReference(secretRef)) {
    throw new Error("Connection Secret bindings must use opaque secret:// references");
  }
  const key = secretRef.slice(SECRET_REFERENCE_PREFIX.length);
  assertValidSecretKey(key);
  return key;
}

/**
 * Mutates sealed Connection credentials and invalidates every lease that could still use the old
 * value. The broker remains the only plaintext delivery path.
 */
export class ConnectionSecretManager {
  constructor(
    private readonly store: MutableSecretStore,
    private readonly broker: SecretBroker
  ) {}

  async rotate(secretRef: string, plaintext: string): Promise<void> {
    await this.store.set(secretStorageKey(secretRef), plaintext);
    this.broker.revokeSecret(secretRef);
  }

  async revokeConnection(
    connectionId: string,
    bindings: Readonly<Record<string, string>>,
    persistRevocation: () => Promise<void>
  ): Promise<void> {
    for (const secretRef of new Set(Object.values(bindings))) {
      await this.store.delete(secretStorageKey(secretRef));
      this.broker.revokeSecret(secretRef);
    }
    this.broker.revokeConnection(connectionId);
    await persistRevocation();
  }
}
