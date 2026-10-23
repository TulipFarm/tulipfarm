import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { defineExtension, registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { readMigrations, rolloutCommonMigrations, workspaceNames } from '@tulipfarm/workspace-storage/provisioning';
import { connect, fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceMaintenance } from '../src/lifecycle.ts';
import { soulStorageConfig } from '../src/soul.ts';

const setupFailed = /^Error: Workspace setup failed; retry the same setup$/;
const probeSql = 'CREATE TABLE {{schema}}.tf_ready_probe (id integer PRIMARY KEY);\n';
const probe = {
  name: '9999_ready_probe.sql',
  sql: probeSql,
  checksum: createHash('sha256').update(probeSql).digest('hex'),
};

async function lifecycleFixture(t) {
  const environment = { ...process.env };
  const reserved = [];
  const pending = [];
  const db = await fixture();
  let storage;
  t.after(async () => {
    try {
      await Promise.allSettled(pending);
      for (const id of reserved)
        await storage?.client.send(
          new DeleteObjectCommand({ Bucket: storage.bucket, Key: `workspaces/${id}/soul/initial.bundle` }),
        );
    } finally {
      storage?.client.destroy();
      for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
      Object.assign(process.env, environment);
      await db.close();
    }
  });
  storage = soulStorageConfig();
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const endpoint = new URL(db.connectionString);
  endpoint.username = '';
  endpoint.password = '';
  Object.assign(process.env, {
    WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
    WORKSPACE_PROVISIONING_DATABASE_URL: db.connectionString,
    WORKSPACE_DATABASE_ENDPOINT: endpoint.href,
  });
  for (const capability of ['RUNTIME', 'MIGRATION', 'CONFIRMATION']) {
    process.env[`WORKSPACE_${capability}_KEY`] = randomBytes(32).toString('hex');
    process.env[`WORKSPACE_${capability}_KEY_ID`] = 'lifecycle-test';
  }
  const baseline = await readMigrations();
  return {
    db,
    baseline,
    published: [...baseline, probe],
    async reserve() {
      const workspace = { id: randomUUID() };
      workspace.names = workspaceNames(workspace.id);
      db.workspaces.push(workspace);
      reserved.push(workspace.id);
      await db.platform.query(
        `WITH u AS (INSERT INTO app.users (name, email, email_verified) VALUES ('Test', replace($1::uuid::text, '-', '') || '@example.test', true) RETURNING id) INSERT INTO app.workspaces (id, request_id, created_by, name, slug) SELECT $1::uuid, gen_random_uuid(), id, 'Reconciled setup', 'reconciled-' || replace($1::uuid::text, '-', '') FROM u`,
        [workspace.id],
      );
      await db.platform.query('INSERT INTO app.workspace_storage (workspace_id) VALUES ($1)', [workspace.id]);
      return workspace;
    },
    initialize(workspaceId, migrations, soul = 'available') {
      const secret = process.env.R2_SECRET_ACCESS_KEY;
      if (soul === 'unavailable') process.env.R2_SECRET_ACCESS_KEY = 'unavailable-soul-credential';
      let maintenance;
      try {
        maintenance = createWorkspaceMaintenance({ migrations });
      } finally {
        process.env.R2_SECRET_ACCESS_KEY = secret;
      }
      const run = maintenance.initializeWorkspaceStorage(workspaceId).finally(() => maintenance.close());
      run.catch(() => undefined);
      pending.push(run);
      return run;
    },
    rollout(migrations) {
      const run = rolloutCommonMigrations({
        connectionString: db.connectionString,
        migrations,
        listWorkspaceIds: async () =>
          (
            await db.platform.query(
              "SELECT workspace_id FROM app.workspace_storage WHERE stage = 'ready' ORDER BY workspace_id",
            )
          ).rows.map(row => row.workspace_id),
      });
      run.catch(() => undefined);
      pending.push(run);
      return run;
    },
    async state(workspace) {
      return (
        await db.platform.query(
          `SELECT s.stage, s.error_code AS "errorCode", w.ready_at IS NOT NULL AS ready
        FROM app.workspace_storage s JOIN app.workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = $1`,
          [workspace.id],
        )
      ).rows[0];
    },
    async receipts(workspace) {
      return (
        await db.platform.query(
          `SELECT name, checksum, applied_at FROM ${workspace.names.schema}.tf_common_migrations ORDER BY name`,
        )
      ).rows;
    },
    async target() {
      return (await db.platform.query('SELECT stream FROM database_management.common_target WHERE id = 1')).rows[0]
        .stream;
    },
    async probeExists(workspace) {
      return (
        await db.platform.query('SELECT to_regclass($1) IS NOT NULL AS present', [
          `${workspace.names.schema}.tf_ready_probe`,
        ])
      ).rows[0].present;
    },
    async soulHeadSet(workspace) {
      return (
        await db.platform.query(
          `SELECT revision IS NOT NULL AS set FROM ${workspace.names.schema}.tf_soul_head WHERE id = 1`,
        )
      ).rows[0].set;
    },
    async waitForLock(query) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const waiting = await db.admin.query(
          "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1",
          [query],
        );
        if (waiting.rows[0].sessions === 1) return;
        await setTimeout(25);
      }
      assert.fail(`A session must wait on a lock while running ${query}`);
    },
  };
}

async function holdRow(setup, sql, values, work) {
  const holder = await connect(setup.db.connectionString);
  try {
    await holder.query('BEGIN');
    await holder.query(sql, values);
    await work();
    await holder.query('COMMIT');
  } finally {
    await holder.end();
  }
}

test('workspace.created is emitted once, after the workspace becomes ready', { timeout: 120000 }, async t => {
  const setup = await lifecycleFixture(t);
  const created = [];
  await registerExtension(
    defineExtension({
      name: 'recorder',
      register(slots) {
        slots.hooks({
          'workspace.created': payload => {
            created.push(payload);
          },
        });
      },
    }),
    { app: 'storage-worker', env: {} },
  );
  t.after(() => resetExtensions());
  const workspace = await setup.reserve();
  await assert.rejects(setup.initialize(workspace.id, setup.baseline, 'unavailable'), setupFailed);
  assert.deepEqual(created, []);
  await setup.initialize(workspace.id, setup.baseline);
  assert.deepEqual(await setup.state(workspace), { stage: 'ready', errorCode: null, ready: true });
  await setup.initialize(workspace.id, setup.baseline);
  const { created_by: userId, name: workspaceName } = (
    await setup.db.platform.query('SELECT created_by, name FROM app.workspaces WHERE id = $1', [workspace.id])
  ).rows[0];
  assert.deepEqual(created, [{ workspaceId: workspace.id, workspaceName, userId }]);
});

test(
  'setup resumed after the final rollout scan installs the published stream before readiness',
  { timeout: 120000 },
  async t => {
    const setup = await lifecycleFixture(t);
    const workspace = await setup.reserve();
    await assert.rejects(setup.initialize(workspace.id, setup.baseline, 'unavailable'), setupFailed);
    assert.deepEqual(await setup.state(workspace), { stage: 'database', errorCode: 'setup_failed', ready: false });
    const installed = await setup.receipts(workspace);
    assert.deepEqual(
      installed.map(receipt => receipt.name),
      setup.baseline.map(({ name }) => name),
    );
    assert.deepEqual((await setup.rollout(setup.published)).results, []);
    assert.deepEqual(
      await setup.target(),
      setup.published.map(({ name, checksum }) => ({ name, checksum })),
    );
    await setup.initialize(workspace.id, setup.published);
    assert.deepEqual(await setup.state(workspace), { stage: 'ready', errorCode: null, ready: true });
    const reconciled = await setup.receipts(workspace);
    assert.deepEqual(
      reconciled.map(({ name, checksum }) => ({ name, checksum })),
      setup.published.map(({ name, checksum }) => ({ name, checksum })),
    );
    assert.deepEqual(reconciled[0], installed[0]);
    assert.equal(await setup.probeExists(workspace), true);
  },
);

test(
  'readiness refuses the stream it provisioned when a rollout publishes a newer target before readiness',
  { timeout: 120000 },
  async t => {
    const setup = await lifecycleFixture(t);
    const workspace = await setup.reserve();
    await assert.rejects(setup.initialize(workspace.id, setup.baseline, 'unavailable'), setupFailed);
    let resumed;
    await holdRow(
      setup,
      `SELECT revision FROM ${workspace.names.schema}.tf_soul_head WHERE id = 1 FOR UPDATE`,
      [],
      async () => {
        resumed = setup.initialize(workspace.id, setup.baseline);
        await setup.waitForLock('UPDATE %tf_soul_head%');
        assert.deepEqual((await setup.rollout(setup.published)).results, []);
      },
    );
    await assert.rejects(resumed, setupFailed);
    assert.equal(await setup.soulHeadSet(workspace), true);
    assert.deepEqual(await setup.state(workspace), { stage: 'database', errorCode: 'setup_failed', ready: false });
    assert.deepEqual(
      (await setup.receipts(workspace)).map(receipt => receipt.name),
      setup.baseline.map(({ name }) => name),
    );
    await setup.initialize(workspace.id, setup.published);
    assert.deepEqual(await setup.state(workspace), { stage: 'ready', errorCode: null, ready: true });
    assert.deepEqual(
      (await setup.receipts(workspace)).map(receipt => receipt.name),
      setup.published.map(({ name }) => name),
    );
    assert.equal(await setup.probeExists(workspace), true);
  },
);

test(
  'a rollout that publishes during readiness waits for it and then upgrades the ready workspace',
  { timeout: 120000 },
  async t => {
    const setup = await lifecycleFixture(t);
    const workspace = await setup.reserve();
    await assert.rejects(setup.initialize(workspace.id, setup.baseline, 'unavailable'), setupFailed);
    let resumed;
    let rollout;
    await holdRow(setup, 'SELECT id FROM app.workspaces WHERE id = $1 FOR UPDATE', [workspace.id], async () => {
      resumed = setup.initialize(workspace.id, setup.baseline);
      await setup.waitForLock('UPDATE app.workspaces SET soul_commit%');
      rollout = setup.rollout(setup.published);
      await setup.waitForLock('SELECT pg_advisory_xact_lock(734129, 0)');
    });
    await resumed;
    assert.deepEqual((await rollout).results, [{ workspaceId: workspace.id, status: 'applied', errorCode: null }]);
    assert.deepEqual(await setup.state(workspace), { stage: 'ready', errorCode: null, ready: true });
    assert.deepEqual(
      (await setup.receipts(workspace)).map(receipt => receipt.name),
      setup.published.map(({ name }) => name),
    );
    assert.equal(await setup.probeExists(workspace), true);
  },
);
