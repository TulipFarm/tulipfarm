import { randomUUID } from "node:crypto";
import type { ConnectionCredentialVault } from "@tulipfarm/integrations";
import { type SecretsService, secretStorageKey } from "@tulipfarm/secrets";

export function createOimCredentialVault(secrets: SecretsService): ConnectionCredentialVault {
  return {
    async create(_integrationId, _slot, plaintext) {
      const reference = `secret://${randomUUID()}` as const;
      await secrets.set(secretStorageKey(reference), plaintext);
      return reference;
    },
    read: (reference) => secrets.get(secretStorageKey(reference)),
    rotate: (reference, plaintext) => secrets.set(secretStorageKey(reference), plaintext),
    async revokeReferences(references) {
      for (const reference of new Set(references)) {
        await secrets.delete(secretStorageKey(reference));
      }
    },
    async revokeConnection(_connectionId, bindings, persistRevocation) {
      for (const reference of new Set(Object.values(bindings))) {
        await secrets.delete(secretStorageKey(reference));
      }
      await persistRevocation();
    },
  };
}
