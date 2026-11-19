/* oxlint-disable tulipfarm/product-copy -- Hostnames and protocol paths, not application copy. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  admitPreview,
  createApp,
  finishBuild,
  issuePreviewTicket,
  putAppGrant,
  readPreviewSession,
  readPreviewTarget,
  recordDraftHost,
  failDraftHost,
  requestDraftHost,
  redeemPreviewTicket,
  registerPreviewHost,
  requestBuild,
  revokeAppGrant,
  setPreviewBuild,
} from '../../src/store/index.ts';
import { connect, fixture, loadPlatformBaseline } from '../../../workspace-storage/test/integration/fixture.mjs';

const migration = name => readFile(new URL(`../../../../apps/database/migrations/${name}`, import.meta.url), 'utf8');

async function setup(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.end();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  await db.platform.query(await migration('0011_app_hostnames.sql'));
  await db.platform.query(await migration('0012_app_preview_sessions.sql'));
  const workspace = await db.create();
  runtime = await connect(db.login(workspace));
  const tx = { client: runtime, schema: workspace.names.schema };
  const created = await createApp(tx, {
    id: randomUUID(),
    kind: 'public',
    slug: 'orders',
    title: 'Orders',
    createdBy: workspace.membershipId,
  });
  const app = created.app;
  await registerPreviewHost(db.platform, { previewKey: app.previewKey, workspaceId: workspace.id, appId: app.id });
  const signIn = async (userId = workspace.userId) => {
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO app.sessions (id, expires_at, token, updated_at, user_id)
       VALUES ($1, now() + interval '1 day', $2, now(), $3)`,
      [id, randomUUID(), userId],
    );
    return id;
  };
  return { db, workspace, tx, app, signIn };
}

test('a preview ticket opens one session on its own host within 60 seconds', { timeout: 120000 }, async t => {
  const { db, workspace, tx, app, signIn } = await setup(t);
  const authSessionId = await signIn();
  const admitted = await admitPreview(tx, app.id, workspace.userId);
  assert.deepEqual(admitted, { ok: true, membershipId: workspace.membershipId, previewKey: app.previewKey });

  const issue = () =>
    issuePreviewTicket(db.platform, {
      previewKey: app.previewKey,
      authSessionId,
      membershipId: workspace.membershipId,
    });
  const { ticket } = await issue();
  const lifetime = await db.platform.query(
    `SELECT round(extract(epoch FROM ticket_expires_at - created_at)) AS ticket,
       round(extract(epoch FROM expires_at - created_at)) AS session
     FROM app.app_preview_sessions`,
  );
  assert.deepEqual(lifetime.rows, [{ ticket: '60', session: '43200' }]);

  assert.equal(await redeemPreviewTicket(db.platform, 'a'.repeat(26), ticket), null);
  const redeemed = await redeemPreviewTicket(db.platform, app.previewKey, ticket);
  assert.match(redeemed.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await redeemPreviewTicket(db.platform, app.previewKey, ticket), null);
  assert.deepEqual(await readPreviewSession(db.platform, app.previewKey, redeemed.token), {
    workspaceId: workspace.id,
    appId: app.id,
    membershipId: workspace.membershipId,
  });
  assert.equal(await readPreviewSession(db.platform, 'a'.repeat(26), redeemed.token), null);
  assert.equal(await readPreviewSession(db.platform, app.previewKey, ticket), null);

  const late = await issue();
  await db.platform.query(
    `UPDATE app.app_preview_sessions SET created_at = created_at - interval '61 seconds',
       ticket_expires_at = ticket_expires_at - interval '61 seconds'
     WHERE redeemed_at IS NULL`,
  );
  assert.equal(await redeemPreviewTicket(db.platform, app.previewKey, late.ticket), null);

  await db.platform.query('DELETE FROM app.sessions WHERE id = $1', [authSessionId]);
  assert.equal(await readPreviewSession(db.platform, app.previewKey, redeemed.token), null);
  assert.deepEqual((await db.platform.query('SELECT count(*)::int AS left FROM app.app_preview_sessions')).rows, [
    { left: 0 },
  ]);
});

test('only current editors preview, and losing edit blocks the next read', { timeout: 120000 }, async t => {
  const { db, workspace, tx, app } = await setup(t);
  const user = randomUUID();
  const viewer = randomUUID();
  await db.platform.query(`INSERT INTO "${tx.schema}".tf_memberships (id, user_id, role) VALUES ($1, $2, 'member')`, [
    viewer,
    user,
  ]);
  await putAppGrant(tx, {
    appId: app.id,
    grantee: { kind: 'member', membershipId: viewer },
    role: 'use',
    grantedBy: workspace.membershipId,
  });
  assert.equal((await admitPreview(tx, app.id, user)).failure.code, 'forbidden');
  assert.equal((await admitPreview(tx, app.id, randomUUID())).failure.code, 'not-found');
  assert.equal((await admitPreview(tx, randomUUID(), workspace.userId)).failure.code, 'not-found');

  const session = { workspaceId: workspace.id, appId: app.id, membershipId: workspace.membershipId };
  assert.deepEqual(await readPreviewTarget(tx, session), { ok: true, target: { kind: 'files', build: null } });

  const commit = 'c'.repeat(40);
  await db.platform.query(`UPDATE "${tx.schema}".tf_app_drafts SET head_commit = $2 WHERE app_id = $1`, [
    app.id,
    commit,
  ]);
  const queued = await requestBuild(tx, {
    appId: app.id,
    commit,
    recipe: { kind: 'copy', root: '.' },
    builder: 'copy@1',
    requestedBy: workspace.membershipId,
  });
  const manifestKey = `builds/${queued.id}/manifest.json`;
  await finishBuild(tx, queued.id, { ok: true, manifestKey, manifestDigest: 'f'.repeat(64), files: 1, bytes: 5 });
  await setPreviewBuild(tx, queued.id);
  assert.deepEqual(await readPreviewTarget(tx, session), {
    ok: true,
    target: { kind: 'files', build: { buildId: queued.id, manifestKey } },
  });

  const server = { kind: 'server', runtime: 'node26', serve: { port: 3000, start: 'node server.js' } };
  await requestBuild(tx, {
    appId: app.id,
    commit,
    recipe: server,
    builder: 'server@1',
    requestedBy: session.membershipId,
  });
  assert.deepEqual(await readPreviewTarget(tx, session), {
    ok: true,
    target: { kind: 'server', host: { state: 'stopped' } },
  });

  await db.platform.query(`UPDATE "${tx.schema}".tf_apps SET disabled_at = now() WHERE id = $1`, [app.id]);
  assert.equal((await readPreviewTarget(tx, session)).failure.code, 'not-found');
  await db.platform.query(`UPDATE "${tx.schema}".tf_apps SET disabled_at = NULL WHERE id = $1`, [app.id]);

  await revokeAppGrant(tx, app.id, { kind: 'member', membershipId: workspace.membershipId });
  assert.equal((await readPreviewTarget(tx, session)).failure.code, 'forbidden');
});

test('a preview host stays bound to the app it was registered for', { timeout: 120000 }, async t => {
  const { db, workspace, app } = await setup(t);
  const host = { previewKey: app.previewKey, workspaceId: workspace.id, appId: app.id };
  await registerPreviewHost(db.platform, host);
  await assert.rejects(registerPreviewHost(db.platform, { ...host, appId: randomUUID() }), {
    message: `Draft host ${app.previewKey} belongs to another app`,
  });
  assert.deepEqual(
    (await db.platform.query('SELECT app_id FROM app.app_preview_hosts WHERE preview_key = $1', [app.previewKey])).rows,
    [{ app_id: app.id }],
  );
});

const server = { kind: 'server', runtime: 'node26', serve: { port: 3000, start: 'node server.js' } };

/** Moves the draft head to `commit` and finishes a server build of it. */
async function serverHead(db, tx, app, membershipId, commit) {
  await db.platform.query(`UPDATE "${tx.schema}".tf_app_drafts SET head_commit = $2 WHERE app_id = $1`, [
    app.id,
    commit,
  ]);
  const build = await requestBuild(tx, {
    appId: app.id,
    commit,
    recipe: server,
    builder: 'server@1',
    requestedBy: membershipId,
  });
  await finishBuild(tx, build.id, {
    ok: true,
    manifestKey: `builds/${build.id}/server.json`,
    manifestDigest: 'f'.repeat(64),
    files: 0,
    bytes: 0,
  });
  return build;
}

const hostRow = async (db, tx, app) =>
  (
    await db.platform.query(
      `SELECT generation::int, build_id, state, host_ref, failure FROM "${tx.schema}".tf_app_draft_hosts
       WHERE app_id = $1`,
      [app.id],
    )
  ).rows[0];

test(
  'opening a server draft starts one draft host per build and restarts lost or failed ones',
  { timeout: 120000 },
  async t => {
    const { db, workspace, tx, app } = await setup(t);
    assert.deepEqual(await requestDraftHost(tx, app.id), { start: null });

    const first = await serverHead(db, tx, app, workspace.membershipId, 'c'.repeat(40));
    assert.deepEqual(await requestDraftHost(tx, app.id), { start: { generation: 1 } });
    assert.deepEqual(await requestDraftHost(tx, app.id), { start: null });
    assert.deepEqual(await hostRow(db, tx, app), {
      generation: 1,
      build_id: first.id,
      state: 'starting',
      host_ref: null,
      failure: null,
    });

    await db.platform.query(
      `UPDATE "${tx.schema}".tf_app_draft_hosts SET updated_at = now() - interval '11 minutes' WHERE app_id = $1`,
      [app.id],
    );
    assert.deepEqual(await requestDraftHost(tx, app.id), { start: { generation: 2 } });
    assert.deepEqual(await recordDraftHost(tx, app.id, 1, 'host-old'), { retiredHostRef: 'host-old' });
    assert.deepEqual(await recordDraftHost(tx, app.id, 2, 'host-2'), { retiredHostRef: null });
    assert.deepEqual(await requestDraftHost(tx, app.id), { start: null });
    assert.equal((await hostRow(db, tx, app)).host_ref, 'host-2');

    const second = await serverHead(db, tx, app, workspace.membershipId, 'd'.repeat(40));
    assert.deepEqual(await requestDraftHost(tx, app.id), { start: { generation: 3 } });
    assert.deepEqual(await hostRow(db, tx, app), {
      generation: 3,
      build_id: second.id,
      state: 'starting',
      host_ref: null,
      failure: null,
    });

    const lost = {
      code: 'host-unavailable',
      message: 'The app server did not start in time. Try again.',
      retryable: true,
    };
    assert.deepEqual(await failDraftHost(tx, app.id, 2, lost), { failed: false });
    assert.deepEqual(await failDraftHost(tx, app.id, 3, lost), { failed: true });
    assert.deepEqual(await recordDraftHost(tx, app.id, 3, 'host-late'), { retiredHostRef: 'host-late' });
    assert.deepEqual(await hostRow(db, tx, app), {
      generation: 3,
      build_id: second.id,
      state: 'failed',
      host_ref: null,
      failure: lost,
    });
    assert.deepEqual(await requestDraftHost(tx, app.id), { start: { generation: 4 } });

    const release = randomUUID();
    await db.platform.query(
      `INSERT INTO "${tx.schema}".tf_app_releases (id, app_id, number, build_id, commit, manifest_digest, published_by)
     VALUES ($1, $2, 1, $3, $4, $5, $6)`,
      [release, app.id, second.id, 'd'.repeat(40), 'f'.repeat(64), workspace.membershipId],
    );
    await db.platform.query(
      `UPDATE "${tx.schema}".tf_apps SET live_release_id = $2, approval_state = 'approved', approval_by = $3, approval_at = now()
     WHERE id = $1`,
      [app.id, release, workspace.membershipId],
    );
    await db.platform.query(`UPDATE "${tx.schema}".tf_app_draft_hosts SET state = 'stopped' WHERE app_id = $1`, [
      app.id,
    ]);
    assert.deepEqual(await requestDraftHost(tx, app.id), { start: null });
    assert.equal((await hostRow(db, tx, app)).generation, 4);
  },
);

test('a server draft previews the state of its own draft host', { timeout: 120000 }, async t => {
  const { db, workspace, tx, app } = await setup(t);
  const session = { workspaceId: workspace.id, appId: app.id, membershipId: workspace.membershipId };
  const target = async () => (await readPreviewTarget(tx, session)).target;

  const first = await serverHead(db, tx, app, workspace.membershipId, 'c'.repeat(40));
  assert.deepEqual(await target(), { kind: 'server', host: { state: 'stopped' } });
  await requestDraftHost(tx, app.id);
  assert.deepEqual(await target(), { kind: 'server', host: { state: 'starting' } });
  await recordDraftHost(tx, app.id, 1, 'host-1');
  assert.deepEqual(await target(), { kind: 'server', host: { state: 'ready', hostRef: 'host-1' } });

  await db.platform.query(`UPDATE "${tx.schema}".tf_apps SET budget_paused_at = now() WHERE id = $1`, [app.id]);
  assert.deepEqual(await target(), {
    kind: 'server',
    host: {
      state: 'failed',
      failure: {
        code: 'budget-exhausted',
        message: 'This app is paused until it has credits to run.',
        retryable: false,
      },
    },
  });
  await db.platform.query(`UPDATE "${tx.schema}".tf_apps SET budget_paused_at = NULL WHERE id = $1`, [app.id]);

  await serverHead(db, tx, app, workspace.membershipId, 'd'.repeat(40));
  assert.deepEqual(await target(), { kind: 'server', host: { state: 'stopped' } });
  await requestDraftHost(tx, app.id);
  const failure = { code: 'host-unavailable', message: 'The app server could not start. Try again.', retryable: true };
  await failDraftHost(tx, app.id, 2, failure);
  assert.deepEqual(await target(), { kind: 'server', host: { state: 'failed', failure } });

  await db.platform.query(`UPDATE "${tx.schema}".tf_app_drafts SET head_commit = $2 WHERE app_id = $1`, [
    app.id,
    'c'.repeat(40),
  ]);
  const release = randomUUID();
  await db.platform.query(
    `INSERT INTO "${tx.schema}".tf_app_releases (id, app_id, number, build_id, commit, manifest_digest, published_by)
     VALUES ($1, $2, 1, $3, $4, $5, $6)`,
    [release, app.id, first.id, 'c'.repeat(40), 'f'.repeat(64), workspace.membershipId],
  );
  await db.platform.query(
    `UPDATE "${tx.schema}".tf_apps SET live_release_id = $2, approval_state = 'approved', approval_by = $3, approval_at = now()
     WHERE id = $1`,
    [app.id, release, workspace.membershipId],
  );
  await db.platform.query(
    `INSERT INTO "${tx.schema}".tf_app_runtimes (app_id, live_release_id, size_vcpu, size_mem_mib, host_ref, state)
     VALUES ($1, $2, 1, 1024, 'live-host', 'serving')`,
    [app.id, release],
  );
  assert.deepEqual(await target(), { kind: 'server', host: { state: 'ready', hostRef: 'live-host' } });
});
