import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseKeyring, type Environment } from '@tulipfarm/keyring';
import { appIdSchema, type AppId } from '../ids.ts';

declare const handleBrand: unique symbol;
/** The HMAC key the gateway signs request handles with, and the keys the API accepts them under. */
export type RequestHandleKey = { readonly current: Buffer; readonly accepted: readonly Buffer[] };

/** The opaque handle the gateway gives an app server for one visitor request it is serving. */
export type RequestHandle = string & { readonly [handleBrand]: true };

/** A handle whose signature checked out, with the app it was minted for and when, in Unix seconds. */
export type SignedRequestHandle = { readonly handle: RequestHandle; readonly appId: AppId; readonly mintedAt: number };

// tfr_ + base64url(app id 16 ‖ minted at, Unix seconds 4 ‖ random 12 ‖ HMAC-SHA256(key, the first 32) truncated to 16):
// 48 bytes, 64 characters, so no two strings decode to the same handle.
const appBytes = 16;
const mintedBytes = 4;
const randomLength = 12;
const macLength = 16;
const signed = appBytes + mintedBytes + randomLength;
const handlePattern = /^tfr_[A-Za-z0-9_-]{64}$/;

/**
 * Derives the handle keys from the workspace runtime keyring, which the gateway and the API both need to reach
 * workspace storage, so no other secret has to be provisioned. Handles are signed with the current key and accepted
 * under the previous ones too, so a rotation does not close live requests. Throws when the runtime key is missing or
 * malformed. The key is versioned with the layout: a v1 handle signed its random bytes where v2 keeps the mint time, so
 * it must not verify as v2.
 */
export function requestHandleKey(env: Environment): RequestHandleKey {
  const keyring = parseKeyring(env, 'WORKSPACE_RUNTIME');
  const derive = (key: Buffer) =>
    Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'tulipfarm app request handle v2', 32));
  const current = derive(keyring.key);
  return { current, accepted: [current, ...[...keyring.previous.values()].map(derive)] };
}

const mac = (key: Buffer, body: Buffer) => createHmac('sha256', key).update(body).digest().subarray(0, macLength);

/** A new handle for a request to `appId`. */
export function signRequestHandle(key: RequestHandleKey, appId: AppId): RequestHandle {
  const mintedAt = Buffer.alloc(mintedBytes);
  mintedAt.writeUInt32BE(Math.floor(Date.now() / 1000));
  const body = Buffer.concat([Buffer.from(appId.replaceAll('-', ''), 'hex'), mintedAt, randomBytes(randomLength)]);
  return `tfr_${Buffer.concat([body, mac(key.current, body)]).toString('base64url')}` as RequestHandle;
}

/** The app an untrusted handle was minted for and when, or null when it is malformed or its signature does not match. */
export function verifyRequestHandle(key: RequestHandleKey, input: unknown): SignedRequestHandle | null {
  if (typeof input !== 'string' || !handlePattern.test(input)) return null;
  const bytes = Buffer.from(input.slice(4), 'base64url');
  const body = bytes.subarray(0, signed);
  const tag = bytes.subarray(signed);
  if (!key.accepted.some(accepted => timingSafeEqual(tag, mac(accepted, body)))) return null;
  const hex = body.subarray(0, appBytes).toString('hex');
  const appId = appIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  return { handle: input as RequestHandle, appId, mintedAt: body.readUInt32BE(appBytes) };
}
