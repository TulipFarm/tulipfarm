import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKeepMemory, withKeepProbe } from '../src/keep-memory.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const env = { KEEP_ENDPOINT: 'http://keep.test', KEEP_TOKEN: 'secret-token' };
const ready = () =>
  new Response(JSON.stringify({ status: 'ready', version: '0.1.0' }), {
    headers: { 'content-type': 'application/json' },
  });

test('with the flag off Keep is disabled and never called', async () => {
  const keep = createKeepMemory({
    env: { ...env },
    enabled: async () => false,
    fetch: async () => assert.fail('Keep must not be called while the flag is off'),
  });
  assert.deepEqual(await keep.state(workspaceId), { status: 'disabled' });
});

test('the flag defaults off', async () => {
  const keep = createKeepMemory({
    env: { ...env, NODE_ENV: 'production' },
    fetch: async () => assert.fail('Keep must not be called while the flag is off'),
  });
  assert.deepEqual(await keep.state(workspaceId), { status: 'disabled' });
});

test('without KEEP_ENDPOINT Keep is not configured, and an invalid one fails', async () => {
  const keep = createKeepMemory({
    env: {},
    enabled: async () => true,
    fetch: async () => assert.fail('An unconfigured Keep must not be called'),
  });
  assert.deepEqual(await keep.state(workspaceId), { status: 'not_configured' });
  assert.throws(() => createKeepMemory({ env: { KEEP_ENDPOINT: 'http://user:pass@keep.test/v1' } }), /KEEP_ENDPOINT/);
});

test('an unreachable Keep is unavailable, not an empty answer', async () => {
  const keep = createKeepMemory({
    env: { ...env },
    enabled: async () => true,
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.deepEqual(await keep.state(workspaceId), { status: 'unavailable', reason: 'unreachable' });
});

test('a ready Keep is available, and one probe serves repeated reads', async () => {
  let calls = 0;
  const keep = createKeepMemory({
    env: { ...env },
    enabled: async () => true,
    fetch: async () => {
      calls++;
      return ready();
    },
  });
  assert.deepEqual(await keep.state(workspaceId), { status: 'available', version: '0.1.0' });
  assert.deepEqual(await keep.state(workspaceId), { status: 'available', version: '0.1.0' });
  assert.equal(calls, 1);
});

test('the probe leaves personal memory reads unchanged', async () => {
  const memory = { content: 'Prefers short replies', revision: 3 };
  const probed = [];
  const service = withKeepProbe(
    { read: async () => memory, save: async () => 'saved', delete: async () => 'deleted' },
    { state: async id => (probed.push(id), { status: 'disabled' }) },
  );
  assert.equal(await service.read(workspaceId, 'user-1'), memory);
  assert.equal(await service.save(workspaceId, 'user-1', {}), 'saved');
  assert.deepEqual(probed, [workspaceId]);
});
