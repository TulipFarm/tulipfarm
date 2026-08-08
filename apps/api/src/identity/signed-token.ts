import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The signed short-lived token codec shared by `channel-link.ts` (bind offers) and
 * `integrations/github-install-state.ts` (install-redirect CSRF state): provision/memoize an
 * HMAC signing key in the secret store, then sign and verify `base64url(JSON claims).hex(hmac)`
 * tokens with a constant-time comparison. What the claims mean, how long they're valid, and
 * whether they're also checked against a database row (channel-link's nonce spend; install-state
 * has none) stays with each caller — this module only proves a token was issued by this
 * deployment and decodes intact.
 */

/** Just enough of `SecretsService` to hold one key, so callers need not carry the whole service. */
export interface SigningKeyStore {
  list(): Promise<{ key: string }[]>;
  get(key: string): Promise<string>;
  set(key: string, plaintext: string, type: "auto-generated"): Promise<void>;
}

/**
 * Reads the signing key, provisioning one on first use so a fresh deployment needs no operator
 * step. Existence is checked through `list` rather than by catching `get`, because a secret store
 * that is merely *unreachable* also fails `get` — and minting a second key in that case would
 * silently invalidate every token already in flight.
 */
export async function resolveSigningKey(
  secrets: SigningKeyStore,
  keyName: string
): Promise<Buffer> {
  const known = await secrets.list();
  if (!known.some((meta) => meta.key === keyName)) {
    await secrets.set(keyName, randomBytes(32).toString("base64"), "auto-generated");
  }
  // Re-read rather than returning what was just generated: two API instances can reach this at
  // once, and the loser must sign with the key that actually persisted or its tokens never verify.
  return Buffer.from(await secrets.get(keyName), "base64");
}

/** Memoizes the key for the process. It never rotates, and a token outlives no boot by design. */
export function signingKeyResolver(
  secrets: SigningKeyStore,
  keyName: string
): () => Promise<Buffer> {
  let pending: Promise<Buffer> | undefined;
  return () => {
    pending ??= resolveSigningKey(secrets, keyName);
    return pending;
  };
}

function hmacHex(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

/** Signs `claims` as `base64url(JSON claims).hex(hmac)`. */
export function signToken<T>(key: Buffer, claims: T): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${hmacHex(key, payload)}`;
}

/**
 * Verifies the signature (constant-time) and decodes the claims, or returns `null` for anything
 * malformed or not signed by this key. Callers still owe their own shape/TTL/row checks — this
 * only proves the token came from this deployment.
 */
export function verifyToken<T>(key: Buffer, token: string): T | null {
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const presented = Buffer.from(token.slice(separator + 1), "utf8");
  const expected = Buffer.from(hmacHex(key, payload), "utf8");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof claims !== "object" || claims === null) return null;
    return claims as T;
  } catch {
    // A payload that survived the HMAC but is not our JSON means the key is being reused for
    // something else. Refusing is the only safe reading.
    return null;
  }
}
