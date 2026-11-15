import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createApp,
  listAppVersions,
  publishAppVersion,
  putAppGrant,
  readLiveDefinition,
  restoreAppVersion,
  revokeAppGrant,
  appRole,
} from '../../src/store/index.ts';
import { connect, fixture } from '../../../workspace-storage/test/integration/fixture.mjs';

const page = (text, actions = []) => ({
  pages: [
    {
      id: 'home',
      slug: 'home',
      title: 'Home',
      sources: [],
      actions,
      surface: [
        {
          version: '1.0',
          createSurface: {
            surfaceId: 'home',
            catalogId: 'tulipfarm/apps@1',
            components: [{ id: 'root', component: 'Text', text }],
          },
        },
      ],
    },
  ],
});

async function setup(t) {
  const db = await fixture();
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.end();
    await db.close();
  });
  const workspace = await db.create();
  const schema = workspace.names.schema;
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
  const transact = await session();
  const admin = workspace.membershipId;
  async function member() {
    const id = randomUUID();
    await db.platform.query(`INSERT INTO "${schema}".tf_memberships (id, user_id, role) VALUES ($1, $2, 'member')`, [
      id,
      randomUUID(),
    ]);
    return id;
  }
  const created = await transact(tx =>
    createApp(tx, { id: randomUUID(), kind: 'private', slug: 'deals', title: 'Deals', createdBy: admin }),
  );
  const app = created.app;
  /** Saves pages into the shared draft, as an edit run does, and returns the new draft revision. */
  async function saveDraft(definition) {
    const { rows } = await db.platform.query(
      `UPDATE "${schema}".tf_app_drafts SET definition = $2, revision = revision + 1 WHERE app_id = $1
       RETURNING revision`,
      [app.id, JSON.stringify(definition)],
    );
    return Number(rows[0].revision);
  }
  const versions = () => transact(tx => listAppVersions(tx, app.id));
  const publish = async (text, by = admin) => {
    const revision = await saveDraft(page(text));
    const { generation } = await versions();
    return transact(tx =>
      publishAppVersion(tx, { appId: app.id, requestId: randomUUID(), requestedBy: by, generation, revision }),
    );
  };
  return { db, schema, session, transact, admin, member, app, saveDraft, versions, publish };
}

const liveText = async (transact, appId) =>
  (await transact(tx => readLiveDefinition(tx, appId))).pages[0].surface[0].createSurface.components[0].text;

test('the 51st publish deletes the oldest version and keeps the newest 50', { timeout: 120000 }, async t => {
  const { transact, app, versions, publish } = await setup(t);
  for (let n = 1; n <= 50; n += 1) assert.equal((await publish(`Edition ${n}`)).version.number, n);
  const full = await versions();
  assert.equal(full.versions.length, 50);
  assert.deepEqual([full.versions[0].number, full.versions.at(-1).number], [50, 1]);

  const fiftyFirst = await publish('Edition 51');
  assert.equal(fiftyFirst.version.number, 51);
  const kept = await versions();
  assert.equal(kept.generation, 51);
  assert.equal(kept.versions.length, 50);
  assert.deepEqual([kept.versions[0].number, kept.versions.at(-1).number], [51, 2]);
  assert.deepEqual(
    kept.versions.filter(version => version.live).map(version => version.number),
    [51],
  );
  assert.equal(await liveText(transact, app.id), 'Edition 51');
});

test(
  'two publishes from the same versions list: one goes live, the other is superseded',
  { timeout: 120000 },
  async t => {
    const { session, transact, admin, app, saveDraft, versions } = await setup(t);
    const revision = await saveDraft(page('Pipeline'));
    const { generation } = await versions();
    const [left, right] = [await session(), await session()];
    const request = () => ({ appId: app.id, requestId: randomUUID(), requestedBy: admin, generation, revision });

    const results = await Promise.all([
      left(tx => publishAppVersion(tx, request())),
      right(tx => publishAppVersion(tx, request())),
    ]);
    const [won] = results.filter(result => result.ok);
    const [lost] = results.filter(result => !result.ok);
    assert.equal(won.version.number, 1);
    assert.deepEqual(lost.failure, {
      code: 'superseded',
      message: 'Someone published or restored a newer version. Reload the versions and try again.',
      retryable: false,
    });
    const after = await versions();
    assert.equal(after.generation, 1);
    assert.deepEqual(
      after.versions.map(version => [version.number, version.live]),
      [[1, true]],
    );
    assert.equal(await liveText(transact, app.id), 'Pipeline');
  },
);

test('a repeated publish request returns the version it made', { timeout: 120000 }, async t => {
  const { transact, admin, app, saveDraft, versions } = await setup(t);
  const revision = await saveDraft(page('Pipeline'));
  const input = { appId: app.id, requestId: randomUUID(), requestedBy: admin, generation: 0, revision };
  const first = await transact(tx => publishAppVersion(tx, input));
  const again = await transact(tx => publishAppVersion(tx, input));
  assert.equal(again.version.id, first.version.id);
  assert.equal(again.operation.id, first.operation.id);
  assert.equal(again.operation.kind, 'publish');
  assert.equal((await versions()).versions.length, 1);
});

test('a publish of a draft changed since review leaves the live version', { timeout: 120000 }, async t => {
  const { transact, admin, app, saveDraft, publish } = await setup(t);
  await publish('Reviewed');
  const reviewed = await saveDraft(page('Second look'));
  await saveDraft(page('Changed after review'));
  const result = await transact(tx =>
    publishAppVersion(tx, {
      appId: app.id,
      requestId: randomUUID(),
      requestedBy: admin,
      generation: 1,
      revision: reviewed,
    }),
  );
  assert.equal(result.failure.code, 'stale-draft');
  assert.equal(await liveText(transact, app.id), 'Reviewed');
});

test('a check failure lists what to fix and leaves the live version', { timeout: 120000 }, async t => {
  const { transact, admin, app, saveDraft, publish } = await setup(t);
  await publish('Working');
  const workflowId = randomUUID();
  const revision = await saveDraft(
    page('Broken', [{ id: 'close', label: 'Close', kind: 'run-workflow', workflowId, input: {} }]),
  );
  const result = await transact(tx =>
    publishAppVersion(tx, { appId: app.id, requestId: randomUUID(), requestedBy: admin, generation: 1, revision }),
  );
  assert.equal(result.failure.code, 'definition-invalid');
  assert.deepEqual(result.issues, [
    { path: '/pages/0/actions/0/workflowId', message: `The workflow ${workflowId} no longer exists` },
  ]);

  const unsafe = await saveDraft({ pages: [{ ...page('x').pages[0], slug: 'settings' }] });
  const refused = await transact(tx =>
    publishAppVersion(tx, {
      appId: app.id,
      requestId: randomUUID(),
      requestedBy: admin,
      generation: 1,
      revision: unsafe,
    }),
  );
  assert.deepEqual(refused.issues, [{ path: '/pages/0/slug', message: 'Reserved page slug' }]);
  assert.equal(await liveText(transact, app.id), 'Working');
});

test('restore publishes a copy as a new version and leaves grants as they are now', { timeout: 120000 }, async t => {
  const { transact, admin, member, app, versions, publish } = await setup(t);
  const viewer = await member();
  const editor = await member();
  const grant = (membershipId, role) =>
    transact(tx =>
      putAppGrant(tx, { appId: app.id, grantee: { kind: 'member', membershipId }, role, grantedBy: admin }),
    );
  await grant(viewer, 'use');
  await grant(editor, 'edit');
  const first = await publish('First');
  await publish('Second', editor);
  await transact(tx => revokeAppGrant(tx, app.id, { kind: 'member', membershipId: viewer }));
  await grant(editor, 'use');

  const restored = await transact(tx =>
    restoreAppVersion(tx, {
      appId: app.id,
      requestId: randomUUID(),
      requestedBy: admin,
      generation: 2,
      versionId: first.version.id,
    }),
  );
  assert.equal(restored.version.number, 3);
  assert.equal(restored.version.digest, first.version.digest);
  assert.equal(restored.operation.kind, 'rollback');
  assert.equal(await liveText(transact, app.id), 'First');
  assert.deepEqual(
    (await versions()).versions.map(version => [version.number, version.live]),
    [
      [3, true],
      [2, false],
      [1, false],
    ],
  );
  const role = id => transact(tx => appRole(tx, app.id, id));
  assert.deepEqual([await role(viewer), await role(editor)], [null, 'use']);

  const byViewer = await transact(tx =>
    restoreAppVersion(tx, {
      appId: app.id,
      requestId: randomUUID(),
      requestedBy: editor,
      generation: 3,
      versionId: first.version.id,
    }),
  );
  assert.equal(byViewer.failure.code, 'forbidden');
});
