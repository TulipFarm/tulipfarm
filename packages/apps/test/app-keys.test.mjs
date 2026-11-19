import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { appKeyRoot, appReleaseKey, verifyAppKey } from '../src/store/index.ts';

const one = 'ab'.repeat(32);
const two = 'cd'.repeat(32);
const release = '0b5e6a2c-4f1d-4c3e-9a7b-1d2e3f4a5b6c';
const other = '7f3c1e2a-9b8d-4c6e-8a1f-2d3e4f5a6b7c';

test('a release key is the HMAC of its release id under the current root', () => {
  const root = appKeyRoot({ TULIPFARM_APP_KEY_ROOT: one });
  const expected = createHmac('sha256', Buffer.from(one, 'hex'))
    .update(`tulipfarm app key v1\0${release}`)
    .digest('base64url');
  assert.equal(appReleaseKey(root, release), `tfk_${expected}`);
  assert.equal(appReleaseKey(root, release).length, 47);
  assert.notEqual(appReleaseKey(root, release), appReleaseKey(root, other));
});

test('only the key of the same release under an accepted root verifies', () => {
  const root = appKeyRoot({ TULIPFARM_APP_KEY_ROOT: one });
  const key = appReleaseKey(root, release);
  assert.equal(verifyAppKey(root, release, key), true);
  for (const input of [
    undefined,
    '',
    [key],
    key.slice(4),
    `${key} `,
    `TFK_${key.slice(4)}`,
    key.slice(0, -1),
    `${key.slice(0, -1)}${key.at(-1) === 'A' ? 'B' : 'A'}`,
    `tfk_${'A'.repeat(43)}`,
    appReleaseKey(root, other),
    appReleaseKey(appKeyRoot({ TULIPFARM_APP_KEY_ROOT: two }), release),
  ])
    assert.equal(verifyAppKey(root, release, input), false, JSON.stringify(input));
});

test('a rotated root signs with the new key and still accepts the old one', () => {
  const before = appKeyRoot({ TULIPFARM_APP_KEY_ROOT: one });
  const after = appKeyRoot({ TULIPFARM_APP_KEY_ROOT: ` ${two} , ${one} ` });
  assert.equal(verifyAppKey(after, release, appReleaseKey(before, release)), true);
  assert.equal(verifyAppKey(after, release, appReleaseKey(after, release)), true);
  assert.equal(verifyAppKey(before, release, appReleaseKey(after, release)), false);
  assert.equal(appReleaseKey(after, release), appReleaseKey(appKeyRoot({ TULIPFARM_APP_KEY_ROOT: two }), release));
});

test('an unset root turns app keys off and a malformed one fails without echoing it', () => {
  assert.equal(appKeyRoot({}), null);
  assert.equal(appKeyRoot({ TULIPFARM_APP_KEY_ROOT: '  ' }), null);
  for (const value of ['ab'.repeat(31), `${one},`, `${one},zz${'a'.repeat(62)}`, 'not-a-key'])
    assert.throws(
      () => appKeyRoot({ TULIPFARM_APP_KEY_ROOT: value }),
      error => error.message === 'TULIPFARM_APP_KEY_ROOT must be comma-separated 64-character hex keys',
    );
});
