import { randomInt } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// Argon2id is the @node-rs/argon2 default algorithm. Hash output is self-describing
// (encoded params), so verify needs only the stored hash + candidate password.

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
