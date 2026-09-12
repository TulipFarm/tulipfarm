import type { SecretBroker } from "./broker";
import { assertValidSecretKey } from "./key-guard";

const SECRET_REFERENCE_PATTERN =
  /^secret:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface MutableSecretStore {
  set(key: string, plaintext: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Maps an opaque Secret reference to its storage key without deriving authority from it. */
export function secretStorageKey(secretRef: string): string {
  const match = SECRET_REFERENCE_PATTERN.exec(secretRef);
  if (match?.[1] === undefined) {
    throw new Error("Connection Secret bindings must use an opaque secret:// UUID reference");
  }
  assertValidSecretKey(match[1]);
  return match[1];
}

/** Mutates Connection credentials and invalidates leases that could use the old value. */
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
