import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const accessTokenScopes = [
  'tables:read',
  'tables:write',
  'files:read',
  'files:write',
  'agents:run',
  'webhooks:manage',
] as const;
export type AccessTokenScope = (typeof accessTokenScopes)[number];
export const accessTokenScopeSchema = z.enum(accessTokenScopes);

const prefix = 'tfp_';
// tfp_<token id, 32 hex>_<secret, 43 base64url characters = 32 bytes>
const tokenPattern = /^tfp_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

/** The digest stored for a token. It covers the whole token, so the id part cannot be swapped onto another secret. */
export function accessTokenDigest(token: string) {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** A new token. The plain value is returned once and never stored. */
export function mintAccessToken() {
  const id = randomUUID();
  const token = `${prefix}${id.replaceAll('-', '')}_${randomBytes(32).toString('base64url')}`;
  return { id, token, digest: accessTokenDigest(token) };
}

/** The token id from a presented bearer value, or null when it is not shaped like a TulipFarm token. */
export function parseAccessToken(value: string) {
  const match = tokenPattern.exec(value);
  if (!match?.[1]) return null;
  const hex = match[1];
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    digest: accessTokenDigest(value),
  };
}

/** The bearer value from an Authorization header, or null when there is none. */
export function bearerValue(header: string | string[] | undefined) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export function looksLikeAccessToken(value: string) {
  return value.startsWith(prefix);
}
