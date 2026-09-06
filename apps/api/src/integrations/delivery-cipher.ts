import { decryptSecret, type EncryptionKeys, encryptSecret } from "@tulipfarm/secrets";

/**
 * Encrypts a stored webhook payload with the deployment's own key.
 *
 * A raw provider payload is business data — an invoice, a customer record, a message — and it sits
 * in the inbox for days waiting to be normalized or replayed. Storing it in the clear would make a
 * database dump a copy of everything every connected provider ever sent.
 */
export interface DeliveryCipher {
  encrypt(raw: Buffer): Promise<string>;
  decrypt(encrypted: string): Promise<Buffer>;
}

export function deliveryCipher(keys: () => EncryptionKeys): DeliveryCipher {
  return {
    async encrypt(raw) {
      // base64 first: a provider may send bytes that are not valid UTF-8, and a string round-trip
      // would replace them, changing the payload a replay reproduces.
      return JSON.stringify(encryptSecret(raw.toString("base64"), keys().current));
    },
    async decrypt(encrypted) {
      const envelope = JSON.parse(encrypted) as Parameters<typeof decryptSecret>[0];
      return Buffer.from(decryptSecret(envelope, keys()), "base64");
    },
  };
}
