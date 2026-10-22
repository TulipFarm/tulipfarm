import {
  decrypt,
  encryptVersioned,
  keyMaterial,
  parseCurrentKey,
  parseKeyring,
  versionedEnvelopeSchema,
  type EncryptionKey,
  type Keyring,
} from '@tulipfarm/keyring';

const envelopeSchema = versionedEnvelopeSchema.extend({ keyId: versionedEnvelopeSchema.shape.keyId.min(1) });
type Binding = { workspaceId: string; generation: number; capability: 'runtime' | 'migration' | 'confirmation' };
export type CredentialKey = EncryptionKey;
export type CredentialKeyring = Keyring;

const prefix = (capability: Binding['capability']) => `WORKSPACE_${capability.toUpperCase()}`;

export function credentialKey(capability: Binding['capability']): CredentialKey {
  return parseCurrentKey(process.env, prefix(capability));
}

export function credentialKeyring(capability: Binding['capability']): CredentialKeyring {
  return parseKeyring(process.env, prefix(capability));
}

const associatedData = (binding: Binding) => (keyId: string) =>
  Buffer.from(JSON.stringify([1, binding.workspaceId, binding.capability, binding.generation, keyId]));

export function encryptCredential(connectionString: string, binding: Binding, key: CredentialKey) {
  return encryptVersioned(connectionString, key, associatedData(binding));
}

export function decryptCredential(value: unknown, binding: Binding, key: CredentialKey | CredentialKeyring) {
  const envelope = envelopeSchema.parse(value);
  if (!keyMaterial(key, envelope.keyId)) throw new Error('Workspace credential key version unavailable');
  return decrypt(envelope, key, associatedData(binding));
}
