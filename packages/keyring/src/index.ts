import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

// One AES-256-GCM keyring for every stored-secret domain. Keys come from
// <PREFIX>_KEY_ID, <PREFIX>_KEY, and optional <PREFIX>_PREVIOUS_KEYS ({"id":"hex"}).
// Each domain keeps its own associated data and error wording; the envelope bytes
// produced here match the per-domain implementations they replaced.

export type KeyringErrorCode = 'configuration-invalid' | 'key-unavailable' | 'envelope-invalid';
export class KeyringError extends Error {
  readonly code: KeyringErrorCode;
  constructor(code: KeyringErrorCode, message: string) {
    super(message);
    this.name = 'KeyringError';
    this.code = code;
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;
export type EncryptionKey = { readonly keyId: string; readonly key: Buffer };
export type Keyring = EncryptionKey & { readonly previous: ReadonlyMap<string, Buffer> };
export type KeyringOptions = { readonly keyId?: RegExp };
export type AssociatedData = Buffer | ((keyId: string) => Buffer);

const hexKey = z.string().regex(/^[a-f0-9]{64}$/i);
const keyIdSchema = (options: KeyringOptions) => (options.keyId ? z.string().regex(options.keyId) : z.string().min(1));

export function keyringVariables(prefix: string) {
  return { keyId: `${prefix}_KEY_ID`, key: `${prefix}_KEY`, previous: `${prefix}_PREVIOUS_KEYS` } as const;
}

/** Reads only the current key. Use parseKeyring when previous keys must decrypt. */
export function parseCurrentKey(env: Environment, prefix: string, options: KeyringOptions = {}): EncryptionKey {
  const names = keyringVariables(prefix);
  const keyId = keyIdSchema(options).safeParse(env[names.keyId]);
  const key = hexKey.safeParse(env[names.key]);
  if (!keyId.success || !key.success)
    throw new KeyringError('configuration-invalid', `${prefix} encryption key configuration is invalid`);
  return { keyId: keyId.data, key: Buffer.from(key.data, 'hex') };
}

export function parseKeyring(env: Environment, prefix: string, options: KeyringOptions = {}): Keyring {
  const current = parseCurrentKey(env, prefix, options);
  const raw = env[keyringVariables(prefix).previous];
  const previous = new Map<string, Buffer>();
  if (raw) {
    let values: Record<string, string>;
    try {
      values = z.record(keyIdSchema(options), hexKey).parse(JSON.parse(raw));
    } catch {
      throw new KeyringError('configuration-invalid', `${prefix} previous encryption keys are invalid`);
    }
    for (const [keyId, value] of Object.entries(values)) {
      if (keyId === current.keyId)
        throw new KeyringError('configuration-invalid', `${prefix} previous encryption keys repeat the current key ID`);
      previous.set(keyId, Buffer.from(value, 'hex'));
    }
  }
  return { ...current, previous };
}

export function keyMaterial(keys: EncryptionKey | Keyring, keyId: string): Buffer | undefined {
  if (keyId === keys.keyId) return keys.key;
  return 'previous' in keys ? keys.previous.get(keyId) : undefined;
}

/** Stored by workspace credentials, email delivery, and invitation copies. */
export const versionedEnvelopeSchema = z.object({
  version: z.literal(1),
  keyId: z.string(),
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});
export type VersionedEnvelope = z.infer<typeof versionedEnvelopeSchema>;
/** Stored by integration credentials and the providers that share their keyring. */
export const compactEnvelopeSchema = z.strictObject({
  keyId: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});
export type CompactEnvelope = z.infer<typeof compactEnvelopeSchema>;
type Sealed = { keyId: string; nonce: string; tag: string; ciphertext: string };

const associated = (data: AssociatedData, keyId: string) => (typeof data === 'function' ? data(keyId) : data);

function seal(plaintext: string, key: EncryptionKey, data: AssociatedData): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
  cipher.setAAD(associated(data, key.keyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    keyId: key.keyId,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

// Property order is part of the stored format: JSON columns keep it byte for byte.
export function encryptVersioned(plaintext: string, key: EncryptionKey, data: AssociatedData): VersionedEnvelope {
  const sealed = seal(plaintext, key, data);
  return { version: 1, keyId: sealed.keyId, nonce: sealed.nonce, ciphertext: sealed.ciphertext, tag: sealed.tag };
}

export function encryptCompact(plaintext: string, key: EncryptionKey, data: AssociatedData): CompactEnvelope {
  const sealed = seal(plaintext, key, data);
  return { keyId: sealed.keyId, nonce: sealed.nonce, tag: sealed.tag, ciphertext: sealed.ciphertext };
}

/** Decrypts with the key named by the envelope: the current key or a previous one. */
export function decrypt(envelope: Sealed, keys: EncryptionKey | Keyring, data: AssociatedData): string {
  const material = keyMaterial(keys, envelope.keyId);
  if (!material) throw new KeyringError('key-unavailable', 'Encryption key version unavailable');
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (nonce.length !== 12 || tag.length !== 16)
    throw new KeyringError('envelope-invalid', 'Encrypted envelope is invalid');
  const decipher = createDecipheriv('aes-256-gcm', material, nonce);
  decipher.setAAD(associated(data, envelope.keyId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/** The key ID an envelope was sealed with, or undefined for a value that is not an envelope. */
export function envelopeKeyId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('keyId' in value)) return undefined;
  return typeof value.keyId === 'string' && value.keyId ? value.keyId : undefined;
}

/** True when an envelope was sealed with a key other than the keyring's current key. */
export function needsReencrypt(value: unknown, keys: Pick<EncryptionKey, 'keyId'>): boolean {
  const keyId = envelopeKeyId(value);
  return keyId !== undefined && keyId !== keys.keyId;
}
