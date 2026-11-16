import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  closeRequestHandle,
  mintRequestHandle,
  renewRequestHandle,
  resolveRequestHandle,
  sweepExpiredRequestHandles,
} from '../../src/store/index.ts';
import {
  fixture,
  loadPlatformBaseline,
  registerPlatformWorkspace,
} from '../../../workspace-storage/test/integration/fixture.mjs';

async function setup(t) {
  const db = await fixture();
  t.after(() => db.close());
  await loadPlatformBaseline(db.platform);
  await db.platform.query(
    await readFile(new URL('../../../../apps/database/migrations/0016_app_live_requests.sql', import.meta.url), 'utf8'),
  );
  const request = { workspaceId: randomUUID(), appId: randomUUID(), releaseId: randomUUID() };
  await registerPlatformWorkspace(db.platform, request.workspaceId);
  const expire = (handle, offset) =>
    db.platform.query(
      `UPDATE app.app_live_requests SET expires_at = clock_timestamp() + make_interval(secs => $2)
       WHERE handle_sha256 = sha256(convert_to($1, 'UTF8'))`,
      [handle, offset],
    );
  return { platform: db.platform, request, expire };
}

test('a handle resolves to its request until the request closes', { timeout: 120000 }, async t => {
  const { platform, request } = await setup(t);
  const { handle } = await mintRequestHandle(platform, request);
  assert.match(handle, /^tfr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await resolveRequestHandle(platform, handle), request);

  const stored = await platform.query(
    `SELECT encode(handle_sha256, 'hex') AS hash, workspace_id, app_id, release_id FROM app.app_live_requests`,
  );
  assert.deepEqual(stored.rows, [
    {
      hash: createHash('sha256').update(handle).digest('hex'),
      workspace_id: request.workspaceId,
      app_id: request.appId,
      release_id: request.releaseId,
    },
  ]);

  await closeRequestHandle(platform, handle);
  assert.equal(await resolveRequestHandle(platform, handle), null);
  await closeRequestHandle(platform, handle);
  assert.deepEqual((await platform.query('SELECT count(*)::int AS left FROM app.app_live_requests')).rows, [
    { left: 0 },
  ]);
});

test('an expired handle stays dead, and renewing an open one extends it by a minute', { timeout: 120000 }, async t => {
  const { platform, request, expire } = await setup(t);
  const lapsed = (await mintRequestHandle(platform, request)).handle;
  const open = (await mintRequestHandle(platform, request)).handle;

  await expire(lapsed, -1);
  assert.equal(await resolveRequestHandle(platform, lapsed), null);
  assert.equal(await renewRequestHandle(platform, lapsed), false);
  assert.equal(await resolveRequestHandle(platform, lapsed), null);

  await expire(open, 5);
  assert.equal(await renewRequestHandle(platform, open), true);
  const remaining = await platform.query(
    `SELECT round(extract(epoch FROM expires_at - clock_timestamp()))::int AS seconds FROM app.app_live_requests
     WHERE handle_sha256 = sha256(convert_to($1, 'UTF8'))`,
    [open],
  );
  assert.deepEqual(remaining.rows, [{ seconds: 60 }]);

  assert.equal(await sweepExpiredRequestHandles(platform), 1);
  assert.deepEqual(await resolveRequestHandle(platform, open), request);
  assert.deepEqual((await platform.query('SELECT count(*)::int AS left FROM app.app_live_requests')).rows, [
    { left: 1 },
  ]);
});

test('malformed or unknown handles resolve to null', { timeout: 120000 }, async t => {
  const { platform, request } = await setup(t);
  const { handle } = await mintRequestHandle(platform, request);
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
  ])
    assert.equal(await resolveRequestHandle(platform, input), null, JSON.stringify(input));
  assert.deepEqual(await resolveRequestHandle(platform, handle), request);
});
