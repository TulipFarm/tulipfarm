import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Signs base64url(JSON claims).hex(hmac); callers enforce shape, TTL, and nonce spending. */

export interface SigningKeyStore {
  list(): Promise<{ key: string }[]>;
  get(key: string): Promise<string>;
  set(key: string, plaintext: string, type: "auto-generated"): Promise<void>;
}

/** Use list before minting; unreachable get must not invalidate tokens in flight. */
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

/** Verify HMAC in constant time; callers still enforce shape, TTL, and row checks. */
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
