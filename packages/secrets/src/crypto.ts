import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptionKeys } from "./keys";

export interface SecretEnvelope {
  encryptedValue: string; // base64 ciphertext
  iv: string; // base64, 12 bytes
  authTag: string; // base64, 16 bytes
}

export class DecryptError extends Error {}

export function encryptSecret(plaintext: string, key: Buffer): SecretEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedValue: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

interface DecodedEnvelope {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

// Decode + structurally validate the envelope once. A malformed envelope (corruption
// at rest) is distinct from a key mismatch: it throws here and is never reclassified
// as a decrypt miss, so it can't masquerade as a key-rotation fallthrough.
function decodeEnvelope(envelope: SecretEnvelope): DecodedEnvelope {
  const iv = Buffer.from(envelope.iv, "base64");
  const authTag = Buffer.from(envelope.authTag, "base64");
  const ciphertext = Buffer.from(envelope.encryptedValue, "base64");

  if (iv.length !== 12) {
    throw new DecryptError(`malformed envelope: iv must be 12 bytes, got ${iv.length}`);
  }
  if (authTag.length !== 16) {
    throw new DecryptError(`malformed envelope: authTag must be 16 bytes, got ${authTag.length}`);
  }

  return { iv, authTag, ciphertext };
}

// Only the GCM auth check (decipher.final) can fail here: the envelope is pre-validated
// and keys are always 32 bytes (loadEncryptionKeys enforces it), so a null return means
// strictly "this key did not authenticate" — the legitimate dual-key fallthrough signal.
function tryDecrypt(decoded: DecodedEnvelope, key: Buffer): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decoded.iv);
    decipher.setAuthTag(decoded.authTag);

    return Buffer.concat([decipher.update(decoded.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function decryptSecret(envelope: SecretEnvelope, keys: EncryptionKeys): string {
  const decoded = decodeEnvelope(envelope);

  const fromCurrent = tryDecrypt(decoded, keys.current);
  if (fromCurrent !== null) {
    return fromCurrent;
  }

  if (keys.previous) {
    const fromPrevious = tryDecrypt(decoded, keys.previous);
    if (fromPrevious !== null) {
      return fromPrevious;
    }
  }

  throw new DecryptError("unable to decrypt secret");
}
