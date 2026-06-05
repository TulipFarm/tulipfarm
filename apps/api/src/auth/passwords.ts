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
