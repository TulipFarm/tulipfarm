import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { edgeStatus } from '../../src/index.ts';
import {
  admitPublish,
  admitRollback,
  appRepositories,
  appRole,
  changeAppStop,
  createApp,
  discardDraftChanges,
  failOperation,
  finishBuild,
  markOperationStaging,
  markReleaseStaged,
  putAppGrant,
  readApp,
  readDraft,
  readSourceBundles,
  readStagedChanges,
  requestBuild,
  saveDraft,
  setPreviewBuild,
  stageDraftChange,
  switchRelease,
  takeLease,
} from '../../src/store/index.ts';
import { git } from '../../src/store/repository.ts';
import { connect, fixture } from '../../../workspace-storage/test/integration/fixture.mjs';
import { startObjectStore } from '../object-store.mjs';

const coAuthor = { name: 'Ada', email: 'ada@example.test' };
const text = value => new TextEncoder().encode(value);
const builder = 'copy@1';

async function setup(t) {
  const db = await fixture();
  const store = await startObjectStore();
  const root = await mkdtemp(join(tmpdir(), 'app-store-'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.end();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await db.close();
  });
  const workspace = await db.create();
  const schema = workspace.names.schema;
  /** A runtime connection that runs each action in its own transaction, as the API does. */
  async function session() {
    const client = await connect(db.login(workspace));
    clients.push(client);
    return async action => {
      await client.query('BEGIN');
      try {
        const result = await action({ client, schema });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
  }
  async function member(role = 'member') {
    const id = randomUUID();
    await db.platform.query(`INSERT INTO "${schema}".tf_memberships (id, user_id, role) VALUES ($1, $2, $3)`, [
      id,
      randomUUID(),
      role,
    ]);
    return id;
  }
  async function conversation(membershipId) {
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO "${schema}".tf_conversations (id, owner_user_id, owner_membership_id)
       SELECT $1, user_id, id FROM "${schema}".tf_memberships WHERE id = $2`,
      [id, membershipId],
    );
    return id;
  }
  const transact = await session();
  const repositories = appRepositories({ root: join(root, 'cache'), storage: store.storage });
  const admin = workspace.membershipId;
  async function publicApp(slug = 'orders') {
    const created = await transact(tx =>
      createApp(tx, { id: randomUUID(), kind: 'public', slug, title: 'Orders', createdBy: admin }),
    );
    assert.equal(created.ok, true);
    return created.app;
  }
  async function approve(appId) {
    await transact(({ client }) =>
      client.query(
        `UPDATE "${schema}".tf_apps SET approval_state = 'approved', approval_by = $2, approval_at = now() WHERE id = $1`,
        [appId, admin],
      ),
    );
  }
  async function build(appId, commit) {
    return transact(async tx => {
      const queued = await requestBuild(tx, {
        appId,
        commit,
        recipe: { kind: 'copy', root: '.' },
        builder,
        requestedBy: admin,
      });
      return finishBuild(tx, queued.id, {
        ok: true,
        manifestKey: `apps/${appId}/builds/${queued.id}/manifest.json`,
        manifestDigest: 'f'.repeat(64),
        files: 1,
        bytes: 15,
      });
    });
  }
  return {
    db,
    store,
    root,
    workspace,
    schema,
    session,
    transact,
    repositories,
    admin,
    member,
    conversation,
    publicApp,
    approve,
    build,
  };
}

test('two publishes admitted together go live in admission order', { timeout: 120000 }, async t => {
  const { session, transact, admin, publicApp, approve, build, schema } = await setup(t);
  const app = await publicApp();
  await approve(app.id);
  const first = await build(app.id, 'a'.repeat(40));
  const second = await build(app.id, 'b'.repeat(40));
  const [left, right] = [await session(), await session()];

  const admitted = await Promise.all([
    left(tx => admitPublish(tx, { appId: app.id, requestId: randomUUID(), requestedBy: admin, buildId: first.id })),
    right(tx => admitPublish(tx, { appId: app.id, requestId: randomUUID(), requestedBy: admin, buildId: second.id })),
  ]);
  assert.deepEqual(
    admitted.map(result => result.ok),
    [true, true],
  );
  const [older, newer] = admitted.map(result => result.operation).sort((a, b) => a.generation - b.generation);
  assert.deepEqual([older.generation, newer.generation], [1, 2]);
  const numbers = await transact(({ client }) =>
    client.query(`SELECT r.number FROM "${schema}".tf_app_releases r WHERE r.id = ANY($1) ORDER BY r.number`, [
      [older.targetReleaseId, newer.targetReleaseId],
    ]),
  );
  assert.deepEqual(numbers.rows, [{ number: 1 }, { number: 2 }]);

  for (const operation of [older, newer]) {
    await transact(async tx => {
      await markOperationStaging(tx, operation.id);
      await markReleaseStaged(tx, operation.targetReleaseId);
    });
  }
  const switched = await Promise.all([
    left(tx => switchRelease(tx, newer.id)),
    right(tx => switchRelease(tx, older.id)),
  ]);
  assert.equal(switched[0].operation.status, 'switched');
  assert.equal(switched[0].edgeVersion, 1);
  assert.equal(switched[1].operation.status, 'superseded');
  assert.equal(switched[1].operation.supersededBy, 2);
  assert.equal(switched[1].operation.failure.code, 'superseded');
  const live = await transact(tx => readApp(tx, app.id));
  assert.equal(live.liveReleaseId, newer.targetReleaseId);
  assert.equal(live.releaseGeneration, 2);

  const again = await transact(tx => switchRelease(tx, older.id));
  assert.equal(again.operation.status, 'superseded');
  assert.equal((await transact(tx => readApp(tx, app.id))).edgeVersion, 1);
});

test('a repeated publish request returns its operation without a new generation', { timeout: 120000 }, async t => {
  const { transact, admin, publicApp, approve, build, schema } = await setup(t);
  const app = await publicApp();
  const built = await build(app.id, 'a'.repeat(40));
  const requestId = randomUUID();
  const publish = () =>
    transact(tx => admitPublish(tx, { appId: app.id, requestId, requestedBy: admin, buildId: built.id }));

  assert.equal((await publish()).failure.code, 'approval-required');
  await approve(app.id);
  const first = await publish();
  const repeat = await publish();
  assert.equal(repeat.operation.id, first.operation.id);
  assert.equal(repeat.operation.generation, 1);
  const releases = await transact(({ client }) =>
    client.query(`SELECT number FROM "${schema}".tf_app_releases WHERE app_id = $1`, [app.id]),
  );
  assert.deepEqual(releases.rows, [{ number: 1 }]);
  assert.equal((await transact(tx => readApp(tx, app.id))).releaseGeneration, 1);
});

test('a publish that lands while the app is paused keeps it paused', { timeout: 120000 }, async t => {
  const { transact, admin, member, publicApp, approve, build } = await setup(t);
  const app = await publicApp();
  await approve(app.id);
  const built = await build(app.id, 'a'.repeat(40));
  const publish = await transact(tx =>
    admitPublish(tx, { appId: app.id, requestId: randomUUID(), requestedBy: admin, buildId: built.id }),
  );
  const pause = await transact(tx =>
    changeAppStop(tx, { appId: app.id, requestId: randomUUID(), requestedBy: admin, kind: 'pause' }),
  );
  assert.equal(pause.ok, true);
  assert.equal(pause.app.edgeVersion, 1);

  const switched = await transact(tx => switchRelease(tx, publish.operation.id));
  assert.equal(switched.operation.status, 'switched');
  assert.equal(switched.edgeVersion, 2);
  const live = await transact(tx => readApp(tx, app.id));
  assert.equal(live.liveReleaseId, publish.operation.targetReleaseId);
  assert.equal(edgeStatus(live.stops), 'paused');

  const editor = await member();
  await transact(tx =>
    putAppGrant(tx, {
      appId: app.id,
      grantee: { kind: 'member', membershipId: editor },
      role: 'edit',
      grantedBy: admin,
    }),
  );
  const disable = await transact(tx =>
    changeAppStop(tx, { appId: app.id, requestId: randomUUID(), requestedBy: editor, kind: 'disable' }),
  );
  assert.equal(disable.failure.code, 'forbidden');
  const disabled = await transact(tx =>
    changeAppStop(tx, { appId: app.id, requestId: randomUUID(), requestedBy: admin, kind: 'disable' }),
  );
  assert.equal(edgeStatus(disabled.app.stops), 'disabled');
  const resumed = await transact(tx =>
    changeAppStop(tx, { appId: app.id, requestId: randomUUID(), requestedBy: editor, kind: 'resume' }),
  );
  assert.equal(edgeStatus(resumed.app.stops), 'disabled');
  assert.equal(resumed.app.edgeVersion, 4);
});

test('rollback needs a staged release and a failed publish leaves the live release', { timeout: 120000 }, async t => {
  const { transact, admin, publicApp, approve, build } = await setup(t);
  const app = await publicApp();
  await approve(app.id);
  const built = await build(app.id, 'a'.repeat(40));
  const request = () => ({ appId: app.id, requestId: randomUUID(), requestedBy: admin });
  const first = await transact(tx => admitPublish(tx, { ...request(), buildId: built.id }));
  const unstaged = await transact(tx =>
    admitRollback(tx, { ...request(), releaseId: first.operation.targetReleaseId }),
  );
  assert.equal(unstaged.failure.code, 'not-found');
  await transact(tx => markReleaseStaged(tx, first.operation.targetReleaseId));
  await transact(tx => switchRelease(tx, first.operation.id));

  const second = await transact(tx => admitPublish(tx, { ...request(), buildId: built.id }));
  const failed = await transact(tx =>
    failOperation(tx, second.operation.id, { code: 'publisher-unavailable', message: 'Down', retryable: true }),
  );
  assert.equal(failed.status, 'failed');
  assert.equal((await transact(tx => switchRelease(tx, second.operation.id))).operation.status, 'failed');
  const rollback = await transact(tx =>
    admitRollback(tx, { ...request(), releaseId: first.operation.targetReleaseId }),
  );
  assert.equal(rollback.operation.generation, 3);
  await transact(tx => switchRelease(tx, rollback.operation.id));
  assert.equal((await transact(tx => readApp(tx, app.id))).liveReleaseId, first.operation.targetReleaseId);
});

test('only one chat holds the draft lease and a cancelled turn frees it', { timeout: 120000 }, async t => {
  const { session, transact, admin, conversation, publicApp } = await setup(t);
  const app = await publicApp();
  const chats = [await conversation(admin), await conversation(admin)];
  const [left, right] = [await session(), await session()];

  const taken = await Promise.all([
    left(tx => takeLease(tx, { appId: app.id, conversationId: chats[0], membershipId: admin })),
    right(tx => takeLease(tx, { appId: app.id, conversationId: chats[1], membershipId: admin })),
  ]);
  assert.deepEqual(taken.map(result => result.ok).sort(), [false, true]);
  const busy = taken.find(result => !result.ok);
  assert.equal(busy.failure.code, 'draft-busy');
  assert.equal(busy.failure.retryable, true);
  const holder = chats[taken.findIndex(result => result.ok)];
  const waiting = chats.find(chat => chat !== holder);

  const staged = await transact(tx =>
    stageDraftChange(
      tx,
      { appId: app.id, conversationId: holder, membershipId: admin, path: 'index.html', content: text('hi') },
      new Map(),
    ),
  );
  assert.equal(staged.ok, true);
  assert.equal(staged.revision, 1);
  await transact(tx => discardDraftChanges(tx, app.id, staged.leaseId));
  const draft = await transact(tx => readDraft(tx, app.id));
  assert.equal(draft.lease, null);
  assert.equal(draft.revision, 1);
  const next = await transact(tx => takeLease(tx, { appId: app.id, conversationId: waiting, membershipId: admin }));
  assert.equal(next.ok, true);
  const unsaved = await transact(({ client, schema }) =>
    client.query(`SELECT count(*)::int AS n FROM "${schema}".tf_app_draft_changes WHERE app_id = $1`, [app.id]),
  );
  assert.equal(unsaved.rows[0].n, 0);
});

test('a save that crashed after storing its bundle saves cleanly on retry', { timeout: 120000 }, async t => {
  const { workspace, store, root, transact, repositories, admin, conversation, publicApp } = await setup(t);
  const app = await publicApp();
  const chat = await conversation(admin);
  async function stage(path, content) {
    const draft = await transact(tx => readDraft(tx, app.id));
    const repository = await repositories.open(
      workspace.id,
      app.id,
      draft.headCommit,
      await transact(tx => readSourceBundles(tx, app.id)),
    );
    const tree = await repositories.tree(repository, draft.headCommit);
    const staged = await transact(tx =>
      stageDraftChange(
        tx,
        { appId: app.id, conversationId: chat, membershipId: admin, path, content: text(content) },
        tree,
      ),
    );
    assert.equal(staged.ok, true);
    return staged;
  }
  const save = (staged, through = transact) =>
    saveDraft(through, repositories, {
      workspaceId: workspace.id,
      appId: app.id,
      leaseId: staged.leaseId,
      expectedRevision: staged.revision,
      coAuthor,
      endLease: true,
    });

  const first = await save(await stage('index.html', '<h1>Orders</h1>'));
  assert.equal(first.ok, true);
  assert.equal(first.revision, 2);

  const staged = await stage('app.js', 'render()');
  let calls = 0;
  const crashing = action => (++calls === 2 ? Promise.reject(new Error('worker lost')) : transact(action));
  await assert.rejects(save(staged, crashing), /worker lost/);
  const afterCrash = await transact(tx => readDraft(tx, app.id));
  assert.equal(afterCrash.headCommit, first.commit);
  assert.equal(afterCrash.revision, 3);

  const retried = await save(staged);
  assert.equal(retried.ok, true);
  assert.equal(retried.revision, 4);
  const bundles = await transact(tx => readSourceBundles(tx, app.id));
  assert.deepEqual(
    bundles.map(bundle => [bundle.seq, bundle.baseCommit, bundle.headCommit]),
    [
      [1, null, first.commit],
      [2, first.commit, retried.commit],
    ],
  );
  const stored = store.keys().filter(key => key.startsWith(`apps/${workspace.id}/${app.id}/source/`));
  assert.equal(stored.length, 3);
  assert.equal(stored.filter(key => !bundles.some(bundle => bundle.objectKey === key)).length, 1);

  const fresh = appRepositories({ root: join(root, 'fresh'), storage: store.storage });
  const restored = await fresh.open(workspace.id, app.id, retried.commit, bundles);
  assert.equal(await git(restored, ['rev-parse', 'refs/heads/main']), retried.commit);
  assert.equal(await git(restored, ['show', `${retried.commit}:app.js`]), 'render()');
  assert.equal(await git(restored, ['show', `${retried.commit}:index.html`]), '<h1>Orders</h1>');
  assert.equal(await git(restored, ['config', 'gc.auto']), '0');
  const draft = await transact(tx => readDraft(tx, app.id));
  assert.equal(draft.headCommit, retried.commit);
  assert.equal(draft.lease, null);
});

test('a save from a stale revision changes nothing', { timeout: 120000 }, async t => {
  const { workspace, transact, repositories, admin, conversation, publicApp } = await setup(t);
  const app = await publicApp();
  const chat = await conversation(admin);
  const stage = content =>
    transact(tx =>
      stageDraftChange(
        tx,
        { appId: app.id, conversationId: chat, membershipId: admin, path: 'a.txt', content: text(content) },
        new Map(),
      ),
    );
  const early = await stage('one');
  await stage('two');
  const stale = await saveDraft(transact, repositories, {
    workspaceId: workspace.id,
    appId: app.id,
    leaseId: early.leaseId,
    expectedRevision: early.revision,
    coAuthor,
    endLease: false,
  });
  assert.equal(stale.failure.code, 'stale-draft');
  assert.equal((await transact(tx => readDraft(tx, app.id))).headCommit, null);
});

test('builds are keyed by what they build and only the current head gets one shown', { timeout: 120000 }, async t => {
  const { transact, admin, publicApp, schema } = await setup(t);
  const app = await publicApp();
  const recipe = { kind: 'copy', root: '.' };
  const commit = 'c'.repeat(40);
  const first = await transact(tx => requestBuild(tx, { appId: app.id, commit, recipe, builder, requestedBy: admin }));
  const again = await transact(tx => requestBuild(tx, { appId: app.id, commit, recipe, builder, requestedBy: admin }));
  assert.equal(again.id, first.id);
  assert.deepEqual(again.status, { status: 'queued' });
  const done = await transact(tx =>
    finishBuild(tx, first.id, { ok: true, manifestKey: 'm', manifestDigest: 'd'.repeat(64), files: 2, bytes: 30 }),
  );
  assert.deepEqual(done.status, { status: 'succeeded', manifestDigest: 'd'.repeat(64), files: 2, bytes: 30 });
  const late = await transact(tx =>
    finishBuild(tx, first.id, { ok: false, failure: { code: 'build-timeout', message: 'Late', retryable: true } }),
  );
  assert.equal(late.status.status, 'succeeded');

  assert.deepEqual(await transact(tx => setPreviewBuild(tx, first.id)), { previewed: false });
  await transact(({ client }) =>
    client.query(`UPDATE "${schema}".tf_app_drafts SET head_commit = $2 WHERE app_id = $1`, [app.id, commit]),
  );
  assert.deepEqual(await transact(tx => setPreviewBuild(tx, first.id)), { previewed: true });
});

test('roles come from the strongest grant a current member holds', { timeout: 120000 }, async t => {
  const { db, transact, admin, member, publicApp, schema } = await setup(t);
  const app = await publicApp();
  const [viewer, teammate, outsider] = [await member(), await member(), await member()];
  const team = randomUUID();
  await db.platform.query(`INSERT INTO "${schema}".tf_teams (id, name) VALUES ($1, 'Ops')`, [team]);
  await db.platform.query(`INSERT INTO "${schema}".tf_member_teams (membership_id, team_id) VALUES ($1, $2)`, [
    teammate,
    team,
  ]);

  const grant = (grantee, role) => transact(tx => putAppGrant(tx, { appId: app.id, grantee, role, grantedBy: admin }));
  assert.equal((await grant({ kind: 'workspace' }, 'edit')).failure.code, 'forbidden');
  await grant({ kind: 'workspace' }, 'use');
  await grant({ kind: 'team', teamId: team }, 'edit');
  const role = id => transact(tx => appRole(tx, app.id, id));
  assert.deepEqual([await role(admin), await role(viewer), await role(teammate)], ['edit', 'use', 'edit']);
  await db.platform.query(`UPDATE "${schema}".tf_memberships SET removed_at = now() WHERE id = $1`, [outsider]);
  assert.equal(await role(outsider), null);

  const retry = await transact(tx =>
    createApp(tx, { id: app.id, kind: 'public', slug: 'orders', title: 'Orders', createdBy: admin }),
  );
  assert.equal(retry.app.id, app.id);
  const clash = await transact(tx =>
    createApp(tx, { id: randomUUID(), kind: 'public', slug: 'orders', title: 'Other', createdBy: admin }),
  );
  assert.equal(clash.failure.code, 'name-taken');
});

async function editor(t) {
  const context = await setup(t);
  const { workspace, root, store, transact, repositories, admin, conversation, publicApp } = context;
  const app = await publicApp();
  const chat = await conversation(admin);
  async function stage(path, content) {
    const draft = await transact(tx => readDraft(tx, app.id));
    const bundles = await transact(tx => readSourceBundles(tx, app.id));
    const repository = await repositories.open(workspace.id, app.id, draft.headCommit, bundles);
    const tree = await repositories.tree(repository, draft.headCommit);
    return transact(tx =>
      stageDraftChange(
        tx,
        { appId: app.id, conversationId: chat, membershipId: admin, path, content: content && text(content) },
        tree,
      ),
    );
  }
  const save = staged =>
    saveDraft(transact, repositories, {
      workspaceId: workspace.id,
      appId: app.id,
      leaseId: staged.leaseId,
      expectedRevision: staged.revision,
      coAuthor,
      endLease: true,
    });
  /** The saved tree, read from a cache restored from the stored bundles alone. */
  async function restoredFiles(commit) {
    const bundles = await transact(tx => readSourceBundles(tx, app.id));
    const fresh = appRepositories({ root: join(root, `fresh-${randomUUID()}`), storage: store.storage });
    const restored = await fresh.open(workspace.id, app.id, commit, bundles);
    const files = {};
    for (const path of (await git(restored, ['ls-tree', '-r', '--name-only', commit])).split('\n'))
      files[path] = await git(restored, ['show', `${commit}:${path}`]);
    return files;
  }
  return { ...context, app, chat, stage, save, restoredFiles };
}

test('a save can turn a directory into a file and a file into a directory', { timeout: 120000 }, async t => {
  const { stage, save, restoredFiles } = await editor(t);
  assert.equal((await save(await stage('a/b', 'nested'))).ok, true);

  await stage('a/b', null);
  const file = await save(await stage('a', 'flat'));
  assert.equal(file.ok, true);
  assert.deepEqual(await restoredFiles(file.commit), { a: 'flat' });

  const directory = await save(await stage('a/c', 'nested again'));
  assert.equal(directory.ok, true);
  assert.deepEqual(await restoredFiles(directory.commit), { 'a/c': 'nested again' });
});

test('no staged path can reach into a Git directory', { timeout: 120000 }, async t => {
  const { stage } = await editor(t);
  for (const path of ['.git/config', 'x/.git/config', 'X/.GIT/y', '.Git']) {
    const staged = await stage(path, 'x');
    assert.deepEqual(staged.failure, {
      code: 'limit-exceeded',
      message: `${path}: Path must stay inside the app`,
      retryable: false,
    });
  }
  assert.equal((await stage('x/.github/config', 'x')).ok, true);
});

test('ending an expired lease with nothing staged leaves the next holder in place', { timeout: 120000 }, async t => {
  const { workspace, session, transact, repositories, admin, conversation, app, chat, schema } = await editor(t);
  const late = await transact(tx => takeLease(tx, { appId: app.id, conversationId: chat, membershipId: admin }));
  await transact(({ client }) =>
    client.query(
      `UPDATE "${schema}".tf_app_drafts SET lease_expires_at = clock_timestamp() - interval '1 minute' WHERE app_id = $1`,
      [app.id],
    ),
  );
  const next = await conversation(admin);
  const other = await session();
  let taken;
  const racing = action =>
    transact(tx =>
      action({
        ...tx,
        client: {
          async query(sql, values) {
            if (!taken && /SET lease_id = NULL/.test(sql))
              taken = await other(otherTx =>
                stageDraftChange(
                  otherTx,
                  { appId: app.id, conversationId: next, membershipId: admin, path: 'b.txt', content: text('b') },
                  new Map(),
                ),
              );
            return tx.client.query(sql, values);
          },
        },
      }),
    );
  const ended = await saveDraft(racing, repositories, {
    workspaceId: workspace.id,
    appId: app.id,
    leaseId: late.leaseId,
    expectedRevision: late.revision,
    coAuthor,
    endLease: true,
  });
  assert.equal(ended.ok, true);
  assert.equal(taken.ok, true);
  const draft = await transact(tx => readDraft(tx, app.id));
  assert.equal(draft.lease?.id, taken.leaseId);
  assert.equal(draft.lease?.conversationId, next);
  const staged = await transact(tx => readStagedChanges(tx, app.id, taken.leaseId));
  assert.deepEqual(
    staged.map(change => [change.path, Buffer.from(change.content).toString()]),
    [['b.txt', 'b']],
  );
});

test('two apps building the same commit and recipe each get their own build', { timeout: 120000 }, async t => {
  const { transact, admin, publicApp } = await setup(t);
  const [orders, invoices] = [await publicApp('orders'), await publicApp('invoices')];
  const commit = 'c'.repeat(40);
  const recipe = { kind: 'copy', root: '.' };
  const request = appId => transact(tx => requestBuild(tx, { appId, commit, recipe, builder, requestedBy: admin }));
  const [first, second] = [await request(orders.id), await request(invoices.id)];
  assert.deepEqual([first.appId, second.appId], [orders.id, invoices.id]);
  assert.notEqual(first.id, second.id);
});
