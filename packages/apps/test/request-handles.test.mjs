import assert from 'node:assert/strict';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { requestHandleKey, signRequestHandle, verifyRequestHandle } from '../src/store/index.ts';

const key = requestHandleKey({ WORKSPACE_RUNTIME_KEY_ID: 'unit', WORKSPACE_RUNTIME_KEY: 'ab'.repeat(32) });
const appId = '0b5e6a2c-4f1d-4c3e-9a7b-1d2e3f4a5b6c';

const signedAt = (t, seconds) => {
  t.mock.timers.enable({ apis: ['Date'], now: seconds * 1000 + 999 });
  const handle = signRequestHandle(key, appId);
  t.mock.timers.reset();
  return handle;
};

test('a signed handle names its app and the second it was minted, and nothing else verifies', t => {
  const handle = signedAt(t, 1_800_000_000);
  assert.deepEqual(verifyRequestHandle(key, handle), { handle, appId, mintedAt: 1_800_000_000 });
  for (const input of [
    undefined,
    '',
    [handle],
    handle.slice(4),
    `${handle} `,
    `TFR_${handle.slice(4)}`,
    handle.slice(0, -1),
    `${handle.slice(0, -1)}+`,
    `tfr_${'A'.repeat(43)}`,
    `tfr_${'A'.repeat(64)}`,
  ])
    assert.equal(verifyRequestHandle(key, input), null, JSON.stringify(input));
});

test('the handle key is derived from the runtime key and required', t => {
  const handle = signedAt(t, 1_800_000_000);
  const same = requestHandleKey({ WORKSPACE_RUNTIME_KEY_ID: 'rotated-id', WORKSPACE_RUNTIME_KEY: 'AB'.repeat(32) });
  assert.deepEqual(
    verifyRequestHandle(same, handle),
    { handle, appId, mintedAt: 1_800_000_000 },
    'only the key bytes matter',
  );
  assert.throws(() => requestHandleKey({}), /WORKSPACE_RUNTIME encryption key configuration is invalid/);
});

test('a rotated runtime key still accepts handles signed under its previous keys', t => {
  const before = { WORKSPACE_RUNTIME_KEY_ID: 'one', WORKSPACE_RUNTIME_KEY: 'ab'.repeat(32) };
  const after = {
    WORKSPACE_RUNTIME_KEY_ID: 'two',
    WORKSPACE_RUNTIME_KEY: 'cd'.repeat(32),
    WORKSPACE_RUNTIME_PREVIOUS_KEYS: JSON.stringify({ one: 'ab'.repeat(32) }),
  };
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const old = signRequestHandle(requestHandleKey(before), appId);
  const rotated = requestHandleKey(after);
  const mintedAt = 1_800_000_000;
  assert.deepEqual(verifyRequestHandle(rotated, old), { handle: old, appId, mintedAt }, 'signed before the rotation');
  const fresh = signRequestHandle(rotated, appId);
  assert.deepEqual(verifyRequestHandle(rotated, fresh), { handle: fresh, appId, mintedAt });
  assert.equal(verifyRequestHandle(requestHandleKey(before), fresh), null, 'new handles use only the current key');
  assert.equal(
    verifyRequestHandle(requestHandleKey({ ...after, WORKSPACE_RUNTIME_PREVIOUS_KEYS: undefined }), old),
    null,
  );
});

test('a handle in the format without a mint time no longer verifies', () => {
  const v1 = Buffer.from(
    hkdfSync('sha256', Buffer.from('ab'.repeat(32), 'hex'), Buffer.alloc(0), 'tulipfarm app request handle v1', 32),
  );
  const body = Buffer.concat([Buffer.from(appId.replaceAll('-', ''), 'hex'), randomBytes(16)]);
  const tag = createHmac('sha256', v1).update(body).digest().subarray(0, 16);
  assert.equal(verifyRequestHandle(key, `tfr_${Buffer.concat([body, tag]).toString('base64url')}`), null);
});
