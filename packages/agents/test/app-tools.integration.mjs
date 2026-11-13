import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { appRepositories, createApp, finishBuild, putAppGrant, requestBuild } from '../../apps/src/store/index.ts';
import { startObjectStore } from '../../apps/test/object-store.mjs';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAppEditing } from '../src/app-tools.ts';

test('an app chat edits its app in a draft that only a finished turn saves', { timeout: 120000 }, async t => {
  const db = await fixture();
  const objects = await startObjectStore();
  const root = await mkdtemp(join(tmpdir(), 'app-tools-'));
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await objects.close();
    await rm(root, { recursive: true, force: true });
    await db.close();
  });
  const w = await db.create(await workspaceTableMigrations());
  const schema = w.names.schema;
  const table = name => `"${schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const platform = { client: db.platform, schema };
  const owner = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const helper = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
    helper.membershipId,
    helper.userId,
  ]);
  const created = await createApp(platform, {
    id: randomUUID(),
    kind: 'public',
    slug: 'orders',
    title: 'Orders',
    createdBy: owner.membershipId,
  });
  const appId = created.app.id;
  await putAppGrant(platform, {
    appId,
    grantee: { kind: 'member', membershipId: helper.membershipId },
    role: 'edit',
    grantedBy: owner.membershipId,
  });
  async function chat(actor, app) {
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_conversations')} (id, owner_user_id, owner_membership_id, app_id) VALUES ($1,$2,$3,$4)`,
      [id, actor.userId, actor.membershipId, app],
    );
    return { workspaceId: w.id, actor, conversationId: id };
  }
  const ownerChat = await chat(owner, appId);
  const helperChat = await chat(helper, appId);
  const plainChat = await chat(owner, null);

  let hosting = true;
  const builds = [];
  const apps = createAppEditing(runtime, {
    repositories: appRepositories({ root: join(root, 'cache'), storage: objects.storage }),
    enabled: async () => hosting,
    async requestBuild({ appId: id, commit, requestedBy }) {
      builds.push(commit);
      const queued = await requestBuild(platform, {
        appId: id,
        commit,
        recipe: { kind: 'copy', root: '.' },
        builder: 'copy@1',
        requestedBy,
      });
      await finishBuild(platform, queued.id, {
        ok: true,
        manifestKey: `apps/${id}/builds/${queued.id}/manifest.json`,
        manifestDigest: 'f'.repeat(64),
        files: 1,
        bytes: 15,
      });
      return queued.id;
    },
    buildPollMs: 10,
  });
  const write = (on, path, content) => apps.invoke(on, { tool: 'apps.files.write', path, content });
  const list = on => apps.invoke(on, { tool: 'apps.files.list' });
  const read = (on, path) => apps.invoke(on, { tool: 'apps.files.read', path, offset: 0, limit: 32000 });
  const lease = async () =>
    (await db.platform.query(`SELECT lease_id FROM ${table('tf_app_drafts')} WHERE app_id = $1`, [appId])).rows[0]
      .lease_id;

  await t.test('the tools refuse a chat that is not an app chat, or a workspace without app hosting', async () => {
    assert.equal(await apps.admitted(plainChat), false);
    assert.deepEqual(await write(plainChat, 'index.html', 'x'), {
      error: 'forbidden',
      message: 'This chat cannot edit an app',
      retryable: false,
    });
    hosting = false;
    assert.equal(await apps.admitted(ownerChat), false);
    assert.deepEqual(await list(ownerChat), {
      error: 'forbidden',
      message: 'App hosting is off in this workspace',
      retryable: false,
    });
    hosting = true;
    assert.equal(await apps.admitted(ownerChat), true);
  });

  await t.test('a cancelled turn drops what it staged and frees the app', async () => {
    assert.deepEqual(await write(ownerChat, 'index.html', '<h1>Draft</h1>'), { revision: 1 });
    assert.deepEqual(await list(ownerChat), { files: [{ path: 'index.html', bytes: 14 }] });
    assert.deepEqual(await apps.finishTurn(ownerChat, 'cancelled'), { saved: null });
    assert.deepEqual(await list(ownerChat), { files: [] });
    assert.equal(await lease(), null);
  });

  let first;
  await t.test('a completed turn saves its changes as the next draft commit', async () => {
    assert.deepEqual(await write(ownerChat, 'index.html', '<h1>Orders</h1>'), { revision: 2 });
    const finished = await apps.finishTurn(ownerChat, 'completed');
    assert.match(finished.saved, /^[0-9a-f]{40}$/);
    first = finished.saved;
    assert.equal(await lease(), null);
    assert.deepEqual(await read(ownerChat, 'index.html'), { path: 'index.html', content: '<h1>Orders</h1>' });
    const status = await apps.invoke(ownerChat, { tool: 'apps.status' });
    assert.deepEqual(status, {
      title: 'Orders',
      draft: { state: 'saved', commit: first },
      revision: 3,
      live: null,
      build: null,
    });
  });

  await t.test('a second editor gets draft-busy while another chat holds the draft', async () => {
    assert.deepEqual(await write(ownerChat, 'about.html', '<p>About</p>'), { revision: 4 });
    assert.deepEqual(await write(helperChat, 'index.html', '<h1>Mine</h1>'), {
      error: 'draft-busy',
      message: 'Unnamed member is editing this app in another chat',
      retryable: true,
    });
    assert.deepEqual(await apps.finishTurn(helperChat, 'cancelled'), { saved: null });
    assert.deepEqual(await list(helperChat), {
      files: [
        { path: 'about.html', bytes: 12 },
        { path: 'index.html', bytes: 15 },
      ],
    });
  });

  await t.test('building the app saves the draft, keeps the chat editing and waits for the build', async () => {
    // eslint-disable-next-line tulipfarm/product-copy -- A tool name, not user-facing copy.
    const built = await apps.invoke(ownerChat, { tool: 'apps.preview.build' });
    assert.equal(built.status, 'succeeded');
    assert.notEqual(built.commit, first);
    assert.deepEqual(builds, [built.commit]);
    assert.notEqual(await lease(), null);
    assert.deepEqual(await apps.invoke(ownerChat, { tool: 'apps.files.delete', path: 'about.html' }), {
      revision: 6,
    });
    assert.deepEqual(await apps.finishTurn(ownerChat, 'failed'), { saved: null });
    assert.deepEqual(await read(helperChat, 'about.html'), { path: 'about.html', content: '<p>About</p>' });
    assert.equal(await lease(), null);
  });

  await t.test('a chat whose lease expired keeps and saves what it staged', async () => {
    const expire = () =>
      db.platform.query(
        `UPDATE ${table('tf_app_drafts')} SET lease_expires_at = clock_timestamp() - interval '1 minute' WHERE app_id = $1`,
        [appId],
      );
    const head = (await apps.invoke(ownerChat, { tool: 'apps.status' })).draft.commit;
    assert.deepEqual(await write(ownerChat, 'late.html', '<p>Late</p>'), { revision: 7 });
    await expire();
    assert.deepEqual(await read(ownerChat, 'late.html'), { path: 'late.html', content: '<p>Late</p>' });
    assert.deepEqual(await write(ownerChat, 'later.html', '<p>Later</p>'), { revision: 8 });
    await expire();
    const finished = await apps.finishTurn(ownerChat, 'completed');
    assert.match(finished.saved, /^[0-9a-f]{40}$/);
    assert.notEqual(finished.saved, head);
    assert.deepEqual(await read(helperChat, 'late.html'), { path: 'late.html', content: '<p>Late</p>' });
    assert.deepEqual(await read(helperChat, 'later.html'), { path: 'later.html', content: '<p>Later</p>' });
  });
});
