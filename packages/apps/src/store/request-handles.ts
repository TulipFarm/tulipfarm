import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCurrentKey, type Environment } from '@tulipfarm/keyring';
import { appIdSchema, type AppId } from '../ids.ts';

declare const keyBrand: unique symbol;
declare const handleBrand: unique symbol;
/** The HMAC key the gateway signs request handles with and the API checks them with. */
export type RequestHandleKey = Buffer & { readonly [keyBrand]: true };

/** The opaque handle the gateway gives an app server for one visitor request it is serving. */
export type RequestHandle = string & { readonly [handleBrand]: true };

/** A handle whose signature checked out, with the app it was minted for. */
export type SignedRequestHandle = { readonly handle: RequestHandle; readonly appId: AppId };

// tfr_ + base64url(app id 16 ‖ random 16 ‖ HMAC-SHA256(key, app id ‖ random) truncated to 16): 48 bytes, 64 characters.
const appBytes = 16;
const randomLength = 16;
const macLength = 16;
const signed = appBytes + randomLength;
const handlePattern = /^tfr_[A-Za-z0-9_-]{64}$/;

/**
 * Derives the handle key from the workspace runtime key, which the gateway and the API both need to reach workspace
 * storage, so no other secret has to be provisioned. Throws when the runtime key is missing or malformed.
 */
export function requestHandleKey(env: Environment): RequestHandleKey {
  const { key } = parseCurrentKey(env, 'WORKSPACE_RUNTIME');
  return Buffer.from(
    hkdfSync('sha256', key, Buffer.alloc(0), 'tulipfarm app request handle v1', 32),
  ) as RequestHandleKey;
}

const mac = (key: RequestHandleKey, body: Buffer) =>
  createHmac('sha256', key).update(body).digest().subarray(0, macLength);

/** A new handle for a request to `appId`. */
export function signRequestHandle(key: RequestHandleKey, appId: AppId): RequestHandle {
  const body = Buffer.concat([Buffer.from(appId.replaceAll('-', ''), 'hex'), randomBytes(randomLength)]);
  return `tfr_${Buffer.concat([body, mac(key, body)]).toString('base64url')}` as RequestHandle;
}

/** The app an untrusted handle was minted for, or null when it is malformed or its signature does not match. */
export function verifyRequestHandle(key: RequestHandleKey, input: unknown): SignedRequestHandle | null {
  if (typeof input !== 'string' || !handlePattern.test(input)) return null;
  const bytes = Buffer.from(input.slice(4), 'base64url');
  const body = bytes.subarray(0, signed);
  if (!timingSafeEqual(bytes.subarray(signed), mac(key, body))) return null;
  const hex = body.subarray(0, appBytes).toString('hex');
  const appId = appIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  return { handle: input as RequestHandle, appId };
}
