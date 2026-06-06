export class EncryptionKeyError extends Error {}

export interface EncryptionKeys {
  current: Buffer;
  previous?: Buffer;
}

const KEY_LENGTH_BYTES = 32;

function decodeKey(value: string, name: string): Buffer {
  const decoded = Buffer.from(value, "base64");

  if (decoded.length !== KEY_LENGTH_BYTES) {
    throw new EncryptionKeyError(
      `${name} must decode to ${KEY_LENGTH_BYTES} bytes, got ${decoded.length}`
    );
  }

  return decoded;
}

export function loadEncryptionKeys(env: NodeJS.ProcessEnv = process.env): EncryptionKeys {
  const currentRaw = env.ENCRYPTION_KEY;

  if (!currentRaw) {
    throw new EncryptionKeyError("ENCRYPTION_KEY is required");
  }

  const current = decodeKey(currentRaw, "ENCRYPTION_KEY");

  const previousRaw = env.ENCRYPTION_KEY_PREVIOUS;
  const previous = previousRaw ? decodeKey(previousRaw, "ENCRYPTION_KEY_PREVIOUS") : undefined;

  return { current, previous };
}
