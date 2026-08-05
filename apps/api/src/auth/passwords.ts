import { randomInt } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// Argon2id is the @node-rs/argon2 default algorithm. Hash output is self-describing
// (encoded params), so verify needs only the stored hash + candidate password.

export const MIN_PASSWORD_LENGTH = 8;
/**
 * Cap input length before feeding it to Argon2. A multi-megabyte password is
 * cryptographically pointless (entropy saturates well below 128 chars) and
 * would let a single request tie up a CPU core for seconds (SEC-AUDIT M-4).
 */
export const MAX_PASSWORD_LENGTH = 128;

export interface PasswordValidationError {
  message: string;
}

/**
 * Validate a candidate password against the policy:
 *   - length between {@link MIN_PASSWORD_LENGTH} and {@link MAX_PASSWORD_LENGTH}
 *
 * Returns `null` on success or a `PasswordValidationError` on failure.
 */
export function validatePassword(password: string): PasswordValidationError | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { message: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { message: `password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    // Malformed/invalid stored hash → treat as non-match rather than throwing.
    return false;
  }
}

// Excludes visually ambiguous characters (0/O, 1/l/I) since this is meant to be read off a
// screen and retyped or pasted from a chat message.
const TEMP_PASSWORD_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";

// One-time temporary password minted for an admin-created user, shared out-of-band (e.g. Slack)
// and never stored in plaintext — only its Argon2 hash is persisted.
export function generateTempPassword(length = 16): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
  }
  return out;
}
