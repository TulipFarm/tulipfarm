import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, connect } from '../../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';

async function registerWorkspace(db, id, stage = 'ready') {
  await db.platform.query(
    `WITH u AS (INSERT INTO app.users (name, email, email_verified) VALUES ('Test', replace($1::uuid::text, '-', '') || '@example.test', true) RETURNING id)
    INSERT INTO app.workspaces (id, request_id, created_by, name, slug) SELECT $1::uuid, gen_random_uuid(), id, 'Test', 'ws-' || replace($1::uuid::text, '-', '') FROM u`,
    [id],
  );
  await db.platform.query(
    `INSERT INTO app.workspace_storage (workspace_id, stage, runtime_credential, migration_credential, confirmation_credential) VALUES ($1, $2, '{}', '{}', '{}')`,
    [id, stage],
  );
}

async function rollout(connectionString) {
  const child = spawn(process.execPath, ['src/cli.ts', 'workspace-rollout', '--env', 'local'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'test', WORKSPACE_PROVISIONING_DATABASE_URL: connectionString },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, report: stdout ? JSON.parse(stdout) : null, stderr };
}

test('workspace rollout CLI preserves existing rows and receipts across partial failure and retries', async t => {
  const db = await fixture();
  t.after(() => db.close());
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const stream = await workspaceTableMigrations();
  const workspaces = [await db.create(stream), await db.create(stream)];
  for (const workspace of workspaces) await registerWorkspace(db, workspace.id);
  const receipts = async workspace =>
    (
      await db.platform.query(
        `SELECT name,checksum,applied_at FROM "${workspace.names.schema}".tf_common_migrations ORDER BY name`,
      )
    ).rows;
  const members = async workspace =>
    (await db.platform.query(`SELECT id,user_id,role FROM "${workspace.names.schema}".tf_memberships ORDER BY id`))
      .rows;
  const before = await Promise.all(
    workspaces.map(async workspace => ({ receipts: await receipts(workspace), members: await members(workspace) })),
  );
  const blocked = workspaces[1];
  await db.platform.query(`UPDATE "${blocked.names.schema}".tf_common_migrations SET checksum=$1 WHERE name=$2`, [
    '0'.repeat(64),
    stream[0].name,
  ]);
  const first = await rollout(db.connectionString);
  assert.equal(first.code, 1);
  assert.deepEqual(first.report, {
    migrations: stream.length,
    applied: 1,
    failed: [{ workspaceId: blocked.id, status: 'blocked', errorCode: 'history_drift' }],
  });
  assert.equal((await receipts(workspaces[0])).length, stream.length);
  assert.equal((await receipts(blocked)).length, stream.length);
  await db.platform.query(`UPDATE "${blocked.names.schema}".tf_common_migrations SET checksum=$1 WHERE name=$2`, [
    stream[0].checksum,
    stream[0].name,
  ]);
  const second = await rollout(db.connectionString);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(second.report, { migrations: stream.length, applied: 2, failed: [] });
  const applied = await Promise.all(workspaces.map(receipts));
  for (const [index, workspace] of workspaces.entries()) {
    assert.deepEqual(applied[index], before[index].receipts);
    assert.deepEqual(
      applied[index].map(({ name, checksum }) => ({ name, checksum })),
      stream.map(({ name, checksum }) => ({ name, checksum })),
    );
    assert.deepEqual(await members(workspace), before[index].members);
  }
  const workspace = workspaces[0];
  const runtime = await connect(db.login(workspace));
  try {
    const folder = await runtime.query(
      `INSERT INTO "${workspace.names.schema}".tf_files
      (id,kind,creator_membership_id,name,ready) VALUES (gen_random_uuid(),'folder',$1,'After upgrade',true) RETURNING name`,
      [workspace.membershipId],
    );
    assert.deepEqual(folder.rows, [{ name: 'After upgrade' }]);
  } finally {
    await runtime.end();
  }
  const repeated = await rollout(db.connectionString);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.deepEqual(await Promise.all(workspaces.map(receipts)), applied);
  assert.deepEqual((await db.platform.query(`SELECT name FROM "${workspace.names.schema}".tf_files`)).rows, [
    { name: 'After upgrade' },
  ]);
  const fresh = await db.create(stream);
  assert.deepEqual(
    (await receipts(fresh)).map(({ name, checksum }) => ({ name, checksum })),
    stream.map(({ name, checksum }) => ({ name, checksum })),
  );
});

test('workspace rollout CLI reports target history drift without changing receipts or disclosing credentials', async t => {
  const db = await fixture();
  t.after(() => db.close());
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const workspace = await db.create();
  await registerWorkspace(db, workspace.id);
  assert.equal((await rollout(db.connectionString)).code, 0);
  await db.platform.query(
    "UPDATE database_management.common_target SET target='stale', stream=jsonb_set(stream,'{0,checksum}',to_jsonb(repeat('0',64)))",
  );
  const target = (await db.platform.query('SELECT * FROM database_management.common_target')).rows;
  const receipts = (
    await db.platform.query(`SELECT * FROM "${workspace.names.schema}".tf_common_migrations ORDER BY name`)
  ).rows;
  const result = await rollout(db.connectionString);
  assert.equal(result.code, 1);
  assert.equal(result.report, null);
  assert.equal(
    result.stderr,
    'Workspace rollout blocked (history_drift): supplied migrations differ from recorded history. Preserve existing migration names, checksums, and order; append new migrations after them.\n',
  );
  assert.equal(result.stderr.includes(new URL(db.connectionString).password), false);
  assert.deepEqual((await db.platform.query('SELECT * FROM database_management.common_target')).rows, target);
  assert.deepEqual(
    (await db.platform.query(`SELECT * FROM "${workspace.names.schema}".tf_common_migrations ORDER BY name`)).rows,
    receipts,
  );
});
