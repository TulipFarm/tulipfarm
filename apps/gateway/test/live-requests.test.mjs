import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openLiveRequest } from '../src/live-requests.ts';

const app = { workspaceId: '00000000-0000-4000-8000-000000000001', appId: '00000000-0000-4000-8000-000000000002' };
const releaseId = '00000000-0000-4000-8000-000000000003';

function fakeStore(renew = async () => true) {
  const calls = { renews: 0, closed: [] };
  const store = {
    dataRelease: async () => releaseId,
    mint: async () => 'tfr_minted',
    renew: async handle => {
      calls.renews += 1;
      return renew(handle);
    },
    close: async handle => {
      calls.closed.push(handle);
    },
    sweep: async () => 0,
  };
  return { store, calls };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = error => assert.fail(error);

test('a renew tick after the connection is gone closes the handle and stops renewing', async () => {
  const { store, calls } = fakeStore();
  let gone = false;
  const live = openLiveRequest(store, app, { renewMs: 10, gone: () => gone, log });
  assert.equal(await live.handle, 'tfr_minted');
  await pause(35);
  assert.ok(calls.renews > 0);
  gone = true;
  await pause(30);
  assert.deepEqual(calls.closed, ['tfr_minted']);
  const renews = calls.renews;
  await pause(40);
  assert.equal(calls.renews, renews);
});

test('a connection gone before the mint settles gets no handle, and the minted one is closed', async () => {
  const { store, calls } = fakeStore();
  const live = openLiveRequest(store, app, { renewMs: 10, gone: () => true, log });
  assert.equal(await live.handle, null);
  await pause(30);
  assert.deepEqual(calls.closed, ['tfr_minted']);
  assert.equal(calls.renews, 0);
});

test('a slow renew is not stacked by later ticks', async () => {
  let finish;
  const { store, calls } = fakeStore(() => new Promise(resolve => (finish = resolve)));
  const live = openLiveRequest(store, app, { renewMs: 10, gone: () => false, log });
  await live.handle;
  await pause(60);
  assert.equal(calls.renews, 1);
  finish(true);
  await pause(25);
  assert.ok(calls.renews >= 2);
  live.close();
});
