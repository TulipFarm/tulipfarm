import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Environment } from '@tulipfarm/keyring';

/**
 * The root keys that per-release app keys derive from. New releases get keys from `current`; the API accepts a key
 * derived from any of `accepted`, so a rotation can keep running releases working until they are replaced.
 */
export type AppKeyRoot = { readonly current: Buffer; readonly accepted: readonly Buffer[] };

/** The header the sandbox's egress proxy adds to every HTTPS call an app server makes to the API. */
export const appKeyHeader = 'TulipFarm-App-Key';

const hexKey = /^[a-f0-9]{64}$/i;
// tfk_ + base64url(HMAC-SHA256(root, label ‖ release id)): 32 bytes, 43 characters.
const keyPattern = /^tfk_[A-Za-z0-9_-]{43}$/;
const label = 'tulipfarm app key v1\0';

/**
 * Reads TULIPFARM_APP_KEY_ROOT: one or more comma-separated 64-character hex keys, the current one first. Returns null
 * when it is unset or empty, so app keys are then neither attached nor checked. Throws, without echoing the value, when
 * it is set but malformed.
 */
export function appKeyRoot(env: Environment): AppKeyRoot | null {
  const raw = env.TULIPFARM_APP_KEY_ROOT?.trim();
  if (!raw) return null;
  const keys = raw.split(',').map(key => key.trim());
  if (!keys.every(key => hexKey.test(key)))
    throw new Error('TULIPFARM_APP_KEY_ROOT must be comma-separated 64-character hex keys');
  const accepted = keys.map(key => Buffer.from(key, 'hex'));
  return { current: accepted[0]!, accepted };
}

const mac = (root: Buffer, releaseId: string) => createHmac('sha256', root).update(label).update(releaseId).digest();

/** The key a release's sandbox presents. Only the sandbox's egress proxy holds it; app code never sees it. */
export function appReleaseKey(root: AppKeyRoot, releaseId: string): string {
  return `tfk_${mac(root.current, releaseId).toString('base64url')}`;
}

/** Whether an untrusted header value is the key of `releaseId` under any accepted root. Compares in constant time. */
export function verifyAppKey(root: AppKeyRoot, releaseId: string, input: unknown): boolean {
  if (typeof input !== 'string' || !keyPattern.test(input)) return false;
  const presented = Buffer.from(input.slice(4), 'base64url');
  if (presented.length !== 32) return false;
  let matched = false;
  // Every root is checked, so the time taken does not tell which one matched.
  for (const accepted of root.accepted) matched = timingSafeEqual(presented, mac(accepted, releaseId)) || matched;
  return matched;
}
