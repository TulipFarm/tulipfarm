import { hash, verify } from "@node-rs/argon2";

// Argon2id is the @node-rs/argon2 default algorithm. Hash output is self-describing
// (encoded params), so verify needs only the stored hash + candidate password.

export const MIN_PASSWORD_LENGTH = 8;
/** Cap input length before Argon2 to prevent CPU exhaustion (SEC-AUDIT M-4). */
export const MAX_PASSWORD_LENGTH = 128;

export interface PasswordValidationError {
  message: string;
}

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
