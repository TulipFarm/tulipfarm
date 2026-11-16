import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestHandleKey, signRequestHandle, verifyRequestHandle } from '../src/store/index.ts';

const key = requestHandleKey({ WORKSPACE_RUNTIME_KEY_ID: 'unit', WORKSPACE_RUNTIME_KEY: 'ab'.repeat(32) });
const appId = '0b5e6a2c-4f1d-4c3e-9a7b-1d2e3f4a5b6c';

test('a signed handle names its app and nothing else verifies', () => {
  const handle = signRequestHandle(key, appId);
  assert.deepEqual(verifyRequestHandle(key, handle), { handle, appId });
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

test('the handle key is derived from the runtime key and required', () => {
  const handle = signRequestHandle(key, appId);
  const same = requestHandleKey({ WORKSPACE_RUNTIME_KEY_ID: 'rotated-id', WORKSPACE_RUNTIME_KEY: 'AB'.repeat(32) });
  assert.deepEqual(verifyRequestHandle(same, handle), { handle, appId }, 'only the key bytes matter');
  assert.throws(() => requestHandleKey({}), /WORKSPACE_RUNTIME encryption key configuration is invalid/);
});
