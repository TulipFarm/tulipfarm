import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  admitPublish,
  claimAppName,
  createApp,
  promoteAppName,
  readApp,
  readOperation,
  readRelease,
  requestBuild,
  setAppPublicName,
} from '@tulipfarm/apps/store';
import {
  connect,
  fixture,
  loadPlatformBaseline,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createAppActivities } from '../src/app-activities.ts';

function memoryObjects() {
  const objects = new Map();
  let puts = 0;
  return {
    objects,
    puts: () => puts,
    async has(key) {
      return objects.has(key);
    },
    async put(key, body, file) {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      puts++;
      objects.set(key, { content: Buffer.concat(chunks), ...file });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: (async function* () {
          yield object.content;
        })(),
        contentType: object.contentType,
        bytes: object.bytes,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    async *list(prefix) {
      yield* [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
    },
  };
}

/** A publisher whose routes live in a key-value store apart from the database, as an edge network's would. */
function edgePublisher() {
  const routes = new Map();
  const staged = new Map();
  let copies = 0;
  return {
    routes,
    staged,
    copies: () => copies,
    traffic: [],
    async stage({ releaseId, files, read }) {
      const held = staged.get(releaseId) ?? new Map();
      staged.set(releaseId, held);
      for (const file of files) {
        if (held.has(file.path)) continue;
        const chunks = [];
        for await (const chunk of read(file)) chunks.push(chunk);
        copies++;
        held.set(file.path, Buffer.concat(chunks).toString('utf8'));
      }
    },
    async apply(route) {
      const stored = routes.get(route.name);
      if (!stored || stored.version < route.version) routes.set(route.name, route);
      return { stored: routes.get(route.name) };
    },
    async remove({ name, version }) {
      if ((routes.get(name)?.version ?? -1) < version) routes.delete(name);
    },
    async discard({ releaseId }) {
      staged.delete(releaseId);
    },
    async *list() {
      yield* routes.values();
    },
    async *releases() {
      for (const releaseId of staged.keys()) yield { releaseId };
    },
    async *usage() {
      yield* this.traffic;
    },
  };
}

function commitFiles(directory, files) {
  const git = args =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  return Promise.all(Object.entries(files).map(([path, content]) => writeFile(join(directory, path), content))).then(
    () => {
      git(['add', '.']);
      git(['commit', '--quiet', '-m', 'Orders']);
      return git(['rev-parse', 'HEAD']);
    },
  );
}

test('app builds, publishes, reconciles and meters converge however often they run', { timeout: 120000 }, async t => {
  const db = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'app-workflows-'));
  let runtime;
  t.after(async () => {
    await runtime?.end();
    await rm(root, { recursive: true, force: true });
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  await db.platform.query(
    await readFile(new URL('../../database/migrations/0011_app_hostnames.sql', import.meta.url), 'utf8'),
  );
  const workspace = await db.create();
  const schema = workspace.names.schema;
  runtime = await connect(db.login(workspace));
  const transact = async action => {
    await runtime.query('BEGIN');
    try {
      const result = await action({ client: runtime, schema });
      await runtime.query('COMMIT');
      return result;
    } catch (error) {
      await runtime.query('ROLLBACK');
      throw error;
    }
  };
  await db.platform.query(`CREATE TABLE "${schema}".test_credit_entries (id text NOT NULL, units numeric NOT NULL)`);
  await db.platform.query(`GRANT SELECT, INSERT ON "${schema}".test_credit_entries TO "${workspace.names.runtime}"`);
  const credits = {
    async available(tx) {
      const { rows } = await tx.client.query(
        `SELECT (1000 - COALESCE(SUM(units), 0))::text AS available FROM "${schema}".test_credit_entries`,
      );
      return BigInt(rows[0].available);
    },
    async debit(tx, units, entry) {
      await tx.client.query(`INSERT INTO "${schema}".test_credit_entries VALUES ($1, $2)`, [
        entry.id,
        units.toString(),
      ]);
    },
  };

  const repository = join(root, 'orders');
  execFileSync('mkdir', [repository]);
  const commit = await commitFiles(repository, {
    'index.html': '<h1>Orders</h1>',
    'app.js': 'console.log("orders")',
  });
  const objects = memoryObjects();
  const publisher = edgePublisher();
  const work = createAppActivities({
    transact: (workspaceId, action) => {
      assert.equal(workspaceId, workspace.id);
      return transact(action);
    },
    platform: db.platform,
    objects,
    source: async () => repository,
    publisher,
    builder: undefined,
    credits,
    async *workspaces() {
      yield workspace.id;
    },
    enabled: async () => true,
  });
  const input = { workspaceId: workspace.id };

  const app = (
    await transact(tx =>
      createApp(tx, {
        id: randomUUID(),
        kind: 'public',
        slug: 'orders',
        title: 'Orders',
        createdBy: workspace.membershipId,
      }),
    )
  ).app;
  await db.platform.query(
    `UPDATE "${schema}".tf_apps SET approval_state = 'approved', approval_by = $2, approval_at = now(),
       monthly_limit_units = 200 WHERE id = $1`,
    [app.id, workspace.membershipId],
  );
  const claim = { name: 'acme-orders', workspaceId: workspace.id, appId: app.id };
  assert.deepEqual(await claimAppName(db.platform, claim), { ok: true });
  await transact(tx => setAppPublicName(tx, app.id, 'acme-orders'));
  await db.platform.query('BEGIN');
  await promoteAppName(db.platform, claim);
  await db.platform.query('COMMIT');

  await t.test('a build and a publish run again after a retry finish once', async () => {
    const build = await transact(tx =>
      requestBuild(tx, {
        appId: app.id,
        commit,
        recipe: { kind: 'copy', root: '.' },
        builder: 'copy@1',
        requestedBy: workspace.membershipId,
      }),
    );
    assert.deepEqual(await work.buildApp({ ...input, buildId: build.id }), { status: 'succeeded' });
    assert.deepEqual(await work.buildApp({ ...input, buildId: build.id }), { status: 'succeeded' });
    assert.equal(objects.puts(), 3);
    const manifest = JSON.parse(objects.objects.get(`builds/${build.id}/manifest.json`).content.toString('utf8'));
    assert.deepEqual(
      manifest.map(file => [file.path, file.bytes, file.contentType]),
      [
        ['app.js', 21, 'text/javascript; charset=utf-8'],
        ['index.html', 15, 'text/html; charset=utf-8'],
      ],
    );

    const admitted = await transact(tx =>
      admitPublish(tx, {
        appId: app.id,
        requestId: randomUUID(),
        requestedBy: workspace.membershipId,
        buildId: build.id,
      }),
    );
    const operation = { ...input, operationId: admitted.operation.id };
    assert.equal(await work.stageAppRelease(operation), true);
    assert.equal(await work.stageAppRelease(operation), true);
    assert.deepEqual(await work.switchAppRelease(operation), { appId: app.id, status: 'switched', switched: true });
    assert.deepEqual(await work.switchAppRelease(operation), { appId: app.id, status: 'switched', switched: false });
    await work.projectAppEdge({ ...input, appId: app.id });
    await work.projectAppEdge({ ...input, appId: app.id });
    assert.equal(await work.stageAppRelease(operation), false);

    const releaseId = admitted.operation.targetReleaseId;
    assert.equal(publisher.copies(), 2);
    assert.deepEqual(Object.fromEntries(publisher.staged.get(releaseId)), {
      'app.js': 'console.log("orders")',
      'index.html': '<h1>Orders</h1>',
    });
    assert.equal((await transact(tx => readOperation(tx, admitted.operation.id))).status, 'switched');
    assert.equal((await transact(tx => readRelease(tx, releaseId))).staged, true);
    assert.deepEqual(publisher.routes.get('acme-orders'), {
      name: 'acme-orders',
      releaseId,
      status: 'active',
      version: 2,
    });
    const { rows } = await db.platform.query(
      `SELECT release_id, status, edge_version::int FROM app.app_hostnames WHERE name = 'acme-orders'`,
    );
    assert.deepEqual(rows, [{ release_id: releaseId, status: 'active', edge_version: 2 }]);
  });

  await t.test('reconcile restores a lost route, retires a stale claim and discards an orphaned release', async () => {
    const route = publisher.routes.get('acme-orders');
    publisher.routes.delete('acme-orders');
    publisher.routes.set('acme-gone', { name: 'acme-gone', releaseId: null, status: 'active', version: 1 });
    const orphan = randomUUID();
    publisher.staged.set(orphan, new Map([['index.html', 'old']]));
    await db.platform.query(
      `INSERT INTO app.app_hostnames (name, workspace_id, app_id, state, claimed_at) VALUES
         ('acme-abandoned', $1, $2, 'claiming', clock_timestamp() - interval '20 minutes'),
         ('acme-pending', $1, $2, 'claiming', clock_timestamp())`,
      [workspace.id, app.id],
    );

    await work.reconcileApps(new AbortController().signal);

    assert.deepEqual(publisher.routes.get('acme-orders'), route);
    assert.equal(publisher.routes.has('acme-gone'), false);
    assert.deepEqual([...publisher.staged.keys()], [route.releaseId]);
    const { rows } = await db.platform.query(
      `SELECT name, state FROM app.app_hostnames WHERE name LIKE 'acme-%' ORDER BY name`,
    );
    assert.deepEqual(
      rows.map(row => [row.name, row.state]),
      [
        ['acme-abandoned', 'retired'],
        ['acme-orders', 'current'],
        ['acme-pending', 'claiming'],
      ],
    );
  });

  await t.test('metering one hour twice records and charges it once, then pauses an app over its limit', async () => {
    publisher.traffic = [{ name: 'acme-orders', requests: 120, bytes: 4096, units: 250n }];
    const window = { start: '2026-11-13T17:00:00.000Z', end: '2026-11-13T18:00:00.000Z' };
    await work.meterAppUsage(window, new AbortController().signal);
    await work.meterAppUsage(window, new AbortController().signal);

    const usage = await db.platform.query(
      `SELECT requests::int, bytes::int, units::text FROM "${schema}".tf_app_usage_windows WHERE app_id = $1`,
      [app.id],
    );
    assert.deepEqual(usage.rows, [{ requests: 120, bytes: 4096, units: '250' }]);
    const debits = await db.platform.query(`SELECT id, units::text FROM "${schema}".test_credit_entries`);
    assert.deepEqual(debits.rows, [{ id: `app-hosting:${app.id}:2026-11-13T17:00:00.000Z`, units: '250' }]);
    const paused = await transact(tx => readApp(tx, app.id));
    assert.notEqual(paused.stops.budgetPausedAt, null);
    assert.deepEqual(publisher.routes.get('acme-orders'), {
      name: 'acme-orders',
      releaseId: paused.liveReleaseId,
      status: 'paused',
      version: 3,
    });
  });
});
