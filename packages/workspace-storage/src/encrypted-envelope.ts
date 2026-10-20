import {
  decrypt,
  encryptVersioned,
  versionedEnvelopeSchema,
  type EncryptionKey,
  type VersionedEnvelope,
} from '@tulipfarm/keyring';

export const encryptedEnvelopeSchema = versionedEnvelopeSchema;

export function encryptEnvelope(plaintext: string, key: EncryptionKey, associatedData: Buffer) {
  return encryptVersioned(plaintext, key, associatedData);
}

export function decryptEnvelope(envelope: VersionedEnvelope, key: Buffer, associatedData: Buffer) {
  return decrypt(envelope, { keyId: envelope.keyId, key }, associatedData);
}
