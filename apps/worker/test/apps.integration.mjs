import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  admitPublish,
  admitRollback,
  changeAppStop,
  claimAppName,
  createApp,
  promoteAppName,
  putAppRuntime,
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
import { hostHeaderPublisher } from '@tulipfarm/apps/host-header-publisher';
import { unavailableAppHost } from '@tulipfarm/extensions';
import { createAppActivities } from '../src/app-activities.ts';
import { captureMetrics } from './metric-capture.mjs';

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
    async *usage(window) {
      if (window.start === this.undelivered) throw new Error('Delivery logs for this hour are not complete');
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
  const telemetry = captureMetrics(t);
  const db = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'app-workflows-'));
  let runtime;
  t.after(async () => {
    await runtime?.end();
    await rm(root, { recursive: true, force: true });
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  for (const migration of ['0011_app_hostnames.sql', '0013_app_server_routes.sql'])
    await db.platform.query(await readFile(new URL(`../../database/migrations/${migration}`, import.meta.url), 'utf8'));
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
  const options = enabled => ({
    transact: (workspaceId, action) => {
      assert.equal(workspaceId, workspace.id);
      return transact(action);
    },
    platform: db.platform,
    objects,
    source: async () => repository,
    publisher,
    builder: undefined,
    host: unavailableAppHost,
    credits,
    async *workspaces() {
      yield workspace.id;
    },
    enabled: async () => enabled,
  });
  const work = createAppActivities(options(true));
  const signal = () => new AbortController().signal;
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
    assert.deepEqual(await telemetry.points('cloud_app_builds'), [
      { outcome: 'succeeded', failure_code: 'none', value: 1 },
    ]);
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
      kind: 'static',
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
    publisher.routes.set('acme-gone', {
      name: 'acme-gone',
      kind: 'static',
      releaseId: null,
      status: 'active',
      version: 1,
    });
    const orphan = randomUUID();
    publisher.staged.set(orphan, new Map([['index.html', 'old']]));
    await db.platform.query(
      `INSERT INTO app.app_hostnames (name, workspace_id, app_id, state, claimed_at) VALUES
         ('acme-abandoned', $1, $2, 'claiming', clock_timestamp() - interval '20 minutes'),
         ('acme-pending', $1, $2, 'claiming', clock_timestamp())`,
      [workspace.id, app.id],
    );

    await work.reconcileApps(new AbortController().signal);
    await work.reconcileApps(new AbortController().signal);

    assert.deepEqual(await telemetry.points('cloud_app_reconcile_repairs'), [
      { kind: 'route-applied', value: 1 },
      { kind: 'route-removed', value: 1 },
      { kind: 'claim-retired', value: 1 },
      { kind: 'release-discarded', value: 1 },
    ]);
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
      kind: 'static',
      releaseId: paused.liveReleaseId,
      status: 'paused',
      version: 3,
    });
  });

  await t.test('a rename that goes live while reconcile lists routes keeps the new name served', async () => {
    const builtIn = hostHeaderPublisher({ sitesDomain: 'sites.example.test', storage: objects, database: db.platform });
    const renamed = { name: 'acme-shop', workspaceId: workspace.id, appId: app.id };
    let rename;
    const hosted = createAppActivities({
      ...options(true),
      publisher: {
        ...builtIn,
        async *list(signal) {
          await rename?.();
          rename = undefined;
          yield* builtIn.list(signal);
        },
      },
    });
    assert.deepEqual(await claimAppName(db.platform, renamed), { ok: true });
    await transact(tx => setAppPublicName(tx, app.id, 'acme-shop'));
    await builtIn.apply(
      { name: 'acme-pending', kind: 'static', releaseId: null, status: 'active', version: 1 },
      signal(),
    );
    rename = async () => {
      await db.platform.query('BEGIN');
      await promoteAppName(db.platform, renamed);
      await db.platform.query('COMMIT');
      await hosted.projectAppEdge({ ...input, appId: app.id });
    };

    await hosted.reconcileApps(signal());
    await hosted.reconcileApps(signal());

    const live = await transact(tx => readApp(tx, app.id));
    const { rows } = await db.platform.query(
      `SELECT name, state, release_id, status, edge_version::int FROM app.app_hostnames
       WHERE name LIKE 'acme-%' ORDER BY name`,
    );
    assert.deepEqual(rows, [
      { name: 'acme-abandoned', state: 'retired', release_id: null, status: null, edge_version: 0 },
      { name: 'acme-orders', state: 'retired', release_id: null, status: null, edge_version: 4 },
      { name: 'acme-pending', state: 'claiming', release_id: null, status: 'active', edge_version: 1 },
      { name: 'acme-shop', state: 'current', release_id: live.liveReleaseId, status: 'paused', edge_version: 4 },
    ]);
  });

  await t.test('reconcile keeps the files of an old release that an admitted rollback points at', async () => {
    const { rows } = await db.platform.query(
      `SELECT id, build_id FROM "${schema}".tf_app_releases WHERE app_id = $1 AND number = 1`,
      [app.id],
    );
    const first = rows[0];
    for (let published = 0; published < 20; published++) {
      const admitted = await transact(tx =>
        admitPublish(tx, {
          appId: app.id,
          requestId: randomUUID(),
          requestedBy: workspace.membershipId,
          buildId: first.build_id,
        }),
      );
      const operation = { ...input, operationId: admitted.operation.id };
      assert.equal(await work.stageAppRelease(operation), true);
      assert.equal((await work.switchAppRelease(operation)).status, 'switched');
    }
    await db.platform.query(
      `UPDATE "${schema}".tf_app_releases SET created_at = clock_timestamp() - interval '2 hours' WHERE app_id = $1`,
      [app.id],
    );
    const rollback = await transact(tx =>
      admitRollback(tx, {
        appId: app.id,
        requestId: randomUUID(),
        requestedBy: workspace.membershipId,
        releaseId: first.id,
      }),
    );
    assert.equal(rollback.operation.status, 'admitted');

    await work.reconcileApps(new AbortController().signal);

    assert.equal(publisher.staged.size, 21);
    assert.deepEqual(Object.fromEntries(publisher.staged.get(first.id)), {
      'app.js': 'console.log("orders")',
      'index.html': '<h1>Orders</h1>',
    });
  });

  await t.test('a rollback admitted while reconcile discards old releases never points at deleted files', async () => {
    const releases = async () =>
      (
        await db.platform.query(`SELECT id, number FROM "${schema}".tf_app_releases WHERE app_id = $1`, [app.id])
      ).rows.reduce((byNumber, row) => ({ ...byNumber, [row.number]: row.id }), {});
    const rollbackTo = (tx, releaseId) =>
      admitRollback(tx, { appId: app.id, requestId: randomUUID(), requestedBy: workspace.membershipId, releaseId });
    const files = { 'app.js': 'console.log("orders")', 'index.html': '<h1>Orders</h1>' };
    const { rows: waiting } = await db.platform.query(
      `SELECT id FROM "${schema}".tf_app_operations WHERE app_id = $1 AND status = 'admitted'`,
      [app.id],
    );
    for (const { id } of waiting) await work.failAppOperation({ ...input, operationId: id, message: 'Cancelled' });
    const live = (await transact(tx => readApp(tx, app.id))).liveReleaseId;
    const first = (await releases())[1];

    let late;
    const racing = createAppActivities({
      ...options(true),
      async *workspaces() {
        yield workspace.id;
        late = await transact(tx => rollbackTo(tx, first));
      },
    });
    await racing.reconcileApps(signal());

    assert.deepEqual(late, {
      ok: false,
      failure: { code: 'not-found', message: 'Release not found', retryable: false },
    });
    assert.equal(publisher.staged.has(first), false);
    assert.equal((await transact(tx => readRelease(tx, first))).staged, false);
    assert.equal((await transact(tx => readApp(tx, app.id))).liveReleaseId, live);

    const { rows: built } = await db.platform.query(`SELECT build_id FROM "${schema}".tf_app_releases WHERE id = $1`, [
      live,
    ]);
    const published = await transact(tx =>
      admitPublish(tx, {
        appId: app.id,
        requestId: randomUUID(),
        requestedBy: workspace.membershipId,
        buildId: built[0].build_id,
      }),
    );
    assert.equal(await work.stageAppRelease({ ...input, operationId: published.operation.id }), true);
    assert.equal((await work.switchAppRelease({ ...input, operationId: published.operation.id })).status, 'switched');
    await db.platform.query(
      `UPDATE "${schema}".tf_app_releases SET created_at = clock_timestamp() - interval '2 hours' WHERE app_id = $1`,
      [app.id],
    );
    const second = (await releases())[2];
    const other = await connect(db.login(workspace));
    const watcher = await connect(db.login(workspace));
    await other.query('BEGIN');
    const held = await rollbackTo({ client: other, schema }, second);
    assert.equal(held.operation.status, 'admitted');
    const reconciling = work.reconcileApps(signal());
    const blocked = (async () => {
      for (let attempt = 0; attempt < 250; attempt++) {
        const { rowCount } = await watcher.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%tf_app_releases%FOR UPDATE%'`,
        );
        if (rowCount) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })();
    await Promise.race([reconciling, blocked]);
    await other.query('COMMIT');
    await reconciling;
    await other.end();
    await watcher.end();

    assert.deepEqual(Object.fromEntries(publisher.staged.get(second) ?? []), files);
    const operation = { ...input, operationId: held.operation.id };
    assert.equal(await work.stageAppRelease(operation), true);
    assert.deepEqual(await work.switchAppRelease(operation), { appId: app.id, status: 'switched', switched: true });
  });

  await t.test('metering charges a served app whose workspace has the app-hosting flag off', async () => {
    const off = createAppActivities(options(false));
    publisher.traffic = [{ name: 'acme-shop', requests: 10, bytes: 512, units: 5n }];
    const window = { start: '2026-11-13T18:00:00.000Z', end: '2026-11-13T19:00:00.000Z' };
    await off.meterAppUsage(window, new AbortController().signal);
    await off.meterAppUsage(window, new AbortController().signal);

    const { rows } = await db.platform.query(
      `SELECT id, units::text FROM "${schema}".test_credit_entries WHERE id LIKE '%T18:%'`,
    );
    assert.deepEqual(rows, [{ id: `app-hosting:${app.id}:2026-11-13T18:00:00.000Z`, units: '5' }]);
  });

  await t.test('metering after six missed hours charges each of them once', async () => {
    publisher.traffic = [{ name: 'acme-shop', requests: 3, bytes: 64, units: 2n }];
    const now = Date.parse('2026-11-14T03:00:00.000Z');
    await work.meterAppTraffic(now, new AbortController().signal);
    await work.meterAppTraffic(now, new AbortController().signal);

    const { rows } = await db.platform.query(`SELECT id, units::text FROM "${schema}".test_credit_entries ORDER BY id`);
    assert.deepEqual(
      rows.map(row => [row.id.replace(`app-hosting:${app.id}:`, ''), row.units]),
      [
        ['2026-11-13T17:00:00.000Z', '250'],
        ['2026-11-13T18:00:00.000Z', '5'],
        ['2026-11-13T19:00:00.000Z', '2'],
        ['2026-11-13T20:00:00.000Z', '2'],
        ['2026-11-13T21:00:00.000Z', '2'],
        ['2026-11-13T22:00:00.000Z', '2'],
        ['2026-11-13T23:00:00.000Z', '2'],
        ['2026-11-14T00:00:00.000Z', '2'],
      ],
    );
  });

  const recorded = async after =>
    (
      await db.platform.query(
        `SELECT window_start FROM "${schema}".tf_app_usage_windows WHERE app_id = $1 AND window_start > $2
         ORDER BY window_start`,
        [app.id, after],
      )
    ).rows.map(row => row.window_start.toISOString());

  await t.test('metering at 11:05 charges hours up to 08:00 to 09:00 and leaves later hours to settle', async () => {
    publisher.traffic = [{ name: 'acme-shop', requests: 3, bytes: 64, units: 2n }];
    const now = Date.parse('2026-11-14T11:05:00.000Z');
    await work.meterAppTraffic(now, signal());
    await work.meterAppTraffic(now, signal());

    assert.deepEqual(await recorded('2026-11-14T00:00:00.000Z'), [
      '2026-11-14T01:00:00.000Z',
      '2026-11-14T02:00:00.000Z',
      '2026-11-14T03:00:00.000Z',
      '2026-11-14T04:00:00.000Z',
      '2026-11-14T05:00:00.000Z',
      '2026-11-14T06:00:00.000Z',
      '2026-11-14T07:00:00.000Z',
      '2026-11-14T08:00:00.000Z',
    ]);
  });

  await t.test('an hour whose usage the publisher cannot read yet is charged once by a later run', async () => {
    publisher.undelivered = '2026-11-14T10:00:00.000Z';
    const now = Date.parse('2026-11-14T14:05:00.000Z');
    const first = await work.meterAppTraffic(now, signal());

    assert.deepEqual(
      { start: first.window.start, message: first.error.message },
      { start: '2026-11-14T10:00:00.000Z', message: 'Delivery logs for this hour are not complete' },
    );
    assert.deepEqual(await recorded('2026-11-14T08:00:00.000Z'), ['2026-11-14T09:00:00.000Z']);

    publisher.undelivered = undefined;
    assert.equal(await work.meterAppTraffic(now, signal()), undefined);
    assert.equal(await work.meterAppTraffic(now, signal()), undefined);

    assert.deepEqual(await recorded('2026-11-14T08:00:00.000Z'), [
      '2026-11-14T09:00:00.000Z',
      '2026-11-14T10:00:00.000Z',
      '2026-11-14T11:00:00.000Z',
    ]);
    const { rows } = await db.platform.query(
      `SELECT id, units::text FROM "${schema}".test_credit_entries WHERE id > $1 ORDER BY id`,
      [`app-hosting:${app.id}:2026-11-14T08:00:00.000Z`],
    );
    assert.deepEqual(
      rows.map(row => [row.id.replace(`app-hosting:${app.id}:`, ''), row.units]),
      [
        ['2026-11-14T09:00:00.000Z', '2'],
        ['2026-11-14T10:00:00.000Z', '2'],
        ['2026-11-14T11:00:00.000Z', '2'],
      ],
    );
  });

  const served = async () => {
    const live = await transact(tx => readApp(tx, app.id));
    const { rows } = await db.platform.query(`SELECT status FROM app.app_hostnames WHERE name = 'acme-shop'`);
    return {
      budgetPaused: live.stops.budgetPausedAt !== null,
      editorPaused: live.stops.editorPausedAt !== null,
      edgeVersion: live.edgeVersion,
      name: rows[0].status,
      route: publisher.routes.get('acme-shop')?.status,
    };
  };
  const reconcileTwice = async now => {
    await work.reconcileApps(signal(), now);
    const once = await served();
    await work.reconcileApps(signal(), now);
    assert.deepEqual(await served(), once);
    return once;
  };

  await t.test('an app over its monthly limit resumes when an admin raises the limit', async () => {
    const now = Date.parse('2026-11-14T15:05:00.000Z');
    const before = await reconcileTwice(now);
    assert.deepEqual(before, {
      budgetPaused: true,
      editorPaused: false,
      edgeVersion: before.edgeVersion,
      name: 'paused',
      route: 'paused',
    });

    await db.platform.query(`UPDATE "${schema}".tf_apps SET monthly_limit_units = 100000 WHERE id = $1`, [app.id]);
    assert.deepEqual(await reconcileTwice(now), {
      budgetPaused: false,
      editorPaused: false,
      edgeVersion: before.edgeVersion + 1,
      name: 'active',
      route: 'active',
    });
  });

  await t.test('a workspace that runs out of credits serves its app again once credit is added', async () => {
    await db.platform.query(`INSERT INTO "${schema}".test_credit_entries VALUES ('spent-elsewhere', 5000)`);
    publisher.traffic = [{ name: 'acme-shop', requests: 1, bytes: 16, units: 1n }];
    const now = Date.parse('2026-11-14T15:05:00.000Z');
    await work.meterAppTraffic(now, signal());
    const before = await reconcileTwice(now);
    assert.deepEqual(before, {
      budgetPaused: true,
      editorPaused: false,
      edgeVersion: before.edgeVersion,
      name: 'paused',
      route: 'paused',
    });

    await db.platform.query(`DELETE FROM "${schema}".test_credit_entries WHERE id = 'spent-elsewhere'`);
    assert.deepEqual(await reconcileTwice(now), {
      budgetPaused: false,
      editorPaused: false,
      edgeVersion: before.edgeVersion + 1,
      name: 'active',
      route: 'active',
    });
  });

  await t.test('an app over its monthly limit resumes when the next month starts', async () => {
    await db.platform.query(`UPDATE "${schema}".tf_apps SET monthly_limit_units = 100 WHERE id = $1`, [app.id]);
    await work.meterAppTraffic(Date.parse('2026-11-14T16:05:00.000Z'), signal());
    const before = await reconcileTwice(Date.parse('2026-11-30T23:05:00.000Z'));
    assert.deepEqual(before, {
      budgetPaused: true,
      editorPaused: false,
      edgeVersion: before.edgeVersion,
      name: 'paused',
      route: 'paused',
    });

    assert.deepEqual(await reconcileTwice(Date.parse('2026-12-01T03:05:00.000Z')), {
      budgetPaused: false,
      editorPaused: false,
      edgeVersion: before.edgeVersion + 1,
      name: 'active',
      route: 'active',
    });
  });

  await t.test('lifting a credit pause leaves an editor pause in place', async () => {
    await work.meterAppTraffic(Date.parse('2026-11-14T17:05:00.000Z'), signal());
    const paused = await transact(tx =>
      changeAppStop(tx, {
        appId: app.id,
        kind: 'pause',
        requestId: randomUUID(),
        requestedBy: workspace.membershipId,
      }),
    );
    assert.equal(paused.ok, true);
    const before = await served();
    assert.deepEqual(
      { budgetPaused: before.budgetPaused, editorPaused: before.editorPaused },
      {
        budgetPaused: true,
        editorPaused: true,
      },
    );

    assert.deepEqual(await reconcileTwice(Date.parse('2026-12-01T03:05:00.000Z')), {
      budgetPaused: false,
      editorPaused: true,
      edgeVersion: before.edgeVersion + 1,
      name: 'paused',
      route: 'paused',
    });
  });

  await t.test('an app that runs a server is routed to the gateway without a release', async () => {
    const server = (
      await transact(tx =>
        createApp(tx, {
          id: randomUUID(),
          kind: 'public',
          slug: 'api',
          title: 'API',
          createdBy: workspace.membershipId,
        }),
      )
    ).app;
    const named = { name: 'acme-api', workspaceId: workspace.id, appId: server.id };
    assert.deepEqual(await claimAppName(db.platform, named), { ok: true });
    await transact(tx => setAppPublicName(tx, server.id, 'acme-api'));
    await db.platform.query('BEGIN');
    await promoteAppName(db.platform, named);
    await db.platform.query('COMMIT');
    await transact(async tx => {
      await putAppRuntime(tx, {
        appId: server.id,
        liveReleaseId: null,
        size: { vcpu: 1, memMiB: 1024 },
        hostRef: 'host-1',
        state: 'serving',
        candidate: null,
      });
      await tx.client.query(`UPDATE "${schema}".tf_apps SET edge_version = 7 WHERE id = $1`, [server.id]);
    });

    assert.deepEqual(await work.projectAppEdge({ ...input, appId: server.id }), {
      route: { name: 'acme-api', kind: 'server', status: 'active', version: 7 },
    });
    assert.deepEqual(publisher.routes.get('acme-api'), {
      name: 'acme-api',
      kind: 'server',
      status: 'active',
      version: 7,
    });
    const { rows } = await db.platform.query(
      `SELECT kind, release_id, status, edge_version::int FROM app.app_hostnames WHERE name = 'acme-api'`,
    );
    assert.deepEqual(rows, [{ kind: 'server', release_id: null, status: 'active', edge_version: 7 }]);
  });

  await t.test('a server app is charged its compute with its traffic, once per settled hour', async () => {
    const server = (
      await transact(tx =>
        createApp(tx, {
          id: randomUUID(),
          kind: 'public',
          slug: 'jobs',
          title: 'Jobs',
          createdBy: workspace.membershipId,
        }),
      )
    ).app;
    const named = { name: 'acme-jobs', workspaceId: workspace.id, appId: server.id };
    assert.deepEqual(await claimAppName(db.platform, named), { ok: true });
    await transact(tx => setAppPublicName(tx, server.id, 'acme-jobs'));
    await db.platform.query('BEGIN');
    await promoteAppName(db.platform, named);
    await db.platform.query('COMMIT');
    const window = { start: '2026-11-15T05:00:00.000Z', end: '2026-11-15T06:00:00.000Z' };
    const unsettled = { start: '2026-11-15T06:00:00.000Z', end: '2026-11-15T07:00:00.000Z' };
    const unnamed = randomUUID();
    const metered = createAppActivities({
      ...options(true),
      host: {
        ...unavailableAppHost,
        async *usage(read) {
          if (read.start === unsettled.start) throw new Error('Compute usage for this hour is not complete');
          yield { appId: server.id.toUpperCase(), units: 30n };
          yield { appId: unnamed, units: 900n };
          yield { appId: 'not-an-app', units: 900n };
        },
      },
    });
    publisher.traffic = [{ name: 'acme-jobs', requests: 2, bytes: 100, units: 7n }];
    await metered.meterAppUsage(window, signal());
    await metered.meterAppUsage(window, signal());
    await assert.rejects(metered.meterAppUsage(unsettled, signal()), /not complete/);

    const usage = await db.platform.query(
      `SELECT window_start, requests::int, bytes::int, units::text FROM "${schema}".tf_app_usage_windows
       WHERE app_id = $1 ORDER BY window_start`,
      [server.id],
    );
    assert.deepEqual(
      usage.rows.map(row => ({ ...row, window_start: row.window_start.toISOString() })),
      [{ window_start: window.start, requests: 2, bytes: 100, units: '37' }],
    );
    const debits = await db.platform.query(
      `SELECT id, units::text FROM "${schema}".test_credit_entries WHERE id LIKE '%2026-11-15T0%' ORDER BY id`,
    );
    assert.deepEqual(debits.rows, [{ id: `app-hosting:${server.id}:${window.start}`, units: '37' }]);
  });
});
