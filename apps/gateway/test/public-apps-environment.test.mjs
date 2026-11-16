import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { requestHandleKey, verifyRequestHandle } from '@tulipfarm/apps/store';
import { publicAppsFromEnvironment } from '../src/public-apps-environment.ts';

const env = {
  TULIPFARM_APP_SITES_DOMAIN: 'apps.example.test',
  WORKSPACE_RUNTIME_KEY_ID: 'gateway-test',
  WORKSPACE_RUNTIME_KEY: '11'.repeat(32),
};
const request = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  appId: '22222222-2222-4222-8222-222222222222',
  releaseId: '33333333-3333-4333-8333-333333333333',
};

function mintThroughGateway() {
  const stored = [];
  const platform = { query: async (_sql, values) => (stored.push(values), { rows: [], rowCount: 1 }) };
  const storage = { pool: platform, runtime: { transaction: async () => request.releaseId } };
  const { store } = publicAppsFromEnvironment(env, platform, storage).liveRequests;
  return { stored, mint: () => store.mint(request) };
}

test('a handle the gateway mints verifies as the app it serves and its mint time, and only its digest is stored', async t => {
  const { stored, mint } = mintThroughGateway();
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_500 });
  const handle = await mint();
  t.mock.timers.reset();
  assert.match(handle, /^tfr_[A-Za-z0-9_-]{64}$/);
  assert.deepEqual(verifyRequestHandle(requestHandleKey(env), handle), {
    handle,
    appId: request.appId,
    mintedAt: 1_800_000_000,
  });
  assert.deepEqual(stored, [
    [createHash('sha256').update(handle).digest(), request.workspaceId, request.appId, request.releaseId, 60],
  ]);
  assert.notEqual(await mint(), handle, 'each request gets its own handle');
});

test('a tampered handle, or one signed with another key, does not verify', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const handle = await mintThroughGateway().mint();
  t.mock.timers.reset();
  const key = requestHandleKey(env);
  const bytes = Buffer.from(handle.slice(4), 'base64url');
  const flipped = offset => {
    const copy = Buffer.from(bytes);
    copy[offset] ^= 1;
    return `tfr_${copy.toString('base64url')}`;
  };
  for (const [offset, part] of [
    [0, 'app id'],
    [18, 'mint time'],
    [24, 'random'],
    [47, 'signature'],
  ])
    assert.equal(verifyRequestHandle(key, flipped(offset)), null, part);
  const other = requestHandleKey({ ...env, WORKSPACE_RUNTIME_KEY: '22'.repeat(32) });
  assert.equal(verifyRequestHandle(other, handle), null, 'another key');
  assert.deepEqual(verifyRequestHandle(key, handle), { handle, appId: request.appId, mintedAt: 1_800_000_000 });
});

test('without the runtime key the gateway refuses to start', () => {
  const { WORKSPACE_RUNTIME_KEY: _, ...missing } = env;
  const platform = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.throws(
    () => publicAppsFromEnvironment(missing, platform, { pool: platform, runtime: { transaction: async () => null } }),
    /WORKSPACE_RUNTIME encryption key configuration is invalid/,
  );
});
