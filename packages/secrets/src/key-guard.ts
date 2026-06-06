export class InvalidSecretKeyError extends Error {}

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const VALID_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

export function assertValidSecretKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new InvalidSecretKeyError("Secret key must be a non-empty string");
  }
  if (key.length > 256) {
    throw new InvalidSecretKeyError("Secret key must be at most 256 characters");
  }
  if (!VALID_KEY_PATTERN.test(key)) {
    throw new InvalidSecretKeyError("Secret key contains invalid characters");
  }
  if (DANGEROUS_KEYS.has(key)) {
    throw new InvalidSecretKeyError(`Secret key "${key}" is not allowed`);
  }
}
