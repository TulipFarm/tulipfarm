/* oxlint-disable tulipfarm/product-copy -- Hostnames and protocol paths, not application copy. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  admitPreview,
  admitPublish,
  createApp,
  finishBuild,
  issuePreviewTicket,
  putAppGrant,
  readPreviewSession,
  readPreviewTarget,
  recordRuntimeCandidate,
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

  await db.platform.query(
    `UPDATE "${tx.schema}".tf_apps SET approval_state = 'approved', approval_by = $2, approval_at = now() WHERE id = $1`,
    [app.id, workspace.membershipId],
  );
  const { operation } = await admitPublish(tx, {
    appId: app.id,
    requestId: randomUUID(),
    requestedBy: workspace.membershipId,
    buildId: queued.id,
  });
  await recordRuntimeCandidate(tx, operation.id, 'host-1');
  const server = { kind: 'server', runtime: 'node22', serve: { port: 3000, start: 'node server.js' } };
  await requestBuild(tx, {
    appId: app.id,
    commit,
    recipe: server,
    builder: 'server@1',
    requestedBy: session.membershipId,
  });
  assert.deepEqual(await readPreviewTarget(tx, session), { ok: true, target: { kind: 'server', hostRef: 'host-1' } });

  const next = 'd'.repeat(40);
  await db.platform.query(`UPDATE "${tx.schema}".tf_app_drafts SET head_commit = $2 WHERE app_id = $1`, [app.id, next]);
  await requestBuild(tx, {
    appId: app.id,
    commit: next,
    recipe: server,
    builder: 'server@1',
    requestedBy: session.membershipId,
  });
  assert.deepEqual(await readPreviewTarget(tx, session), { ok: true, target: { kind: 'server', hostRef: null } });

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
