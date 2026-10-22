import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { escapeIdentifier } from 'pg';
import { connect } from '../../src/postgres.ts';
import { migrate } from '../../src/migrations.ts';
import { workspaceStorageInventory } from '../../src/workspace-inventory.ts';

test('inventory counts retained data without printing values and refuses RLS-filtered counts', async () => {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL);
  const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
  const database = `inventory_${randomUUID().replaceAll('-', '')}`;
  const role = `${database}_owner`;
  const user = randomUUID();
  const workspace = randomUUID();
  let client;
  try {
    await admin.query(`CREATE DATABASE ${escapeIdentifier(database)}`);
    const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
    url.pathname = `/${database}`;
    client = await connect(url.href);
    await migrate(client, fileURLToPath(new URL('../../migrations', import.meta.url)));
    await client.query(
      `INSERT INTO app.users (id, name, email, email_verified) VALUES ($1, 'private-name', 'private@example.invalid', true)`,
      [user],
    );
    await client.query(
      `INSERT INTO app.workspaces (id, request_id, created_by, name, slug, soul_commit, soul_bucket, soul_key, ready_at)
      VALUES ($1, $2, $3, 'private-workspace', 'private-slug', $4, 'tulipfarm-cloud-soul-production', $5, now())`,
      [workspace, randomUUID(), user, 'a'.repeat(40), `workspaces/${workspace}/soul/initial.bundle`],
    );
    await client.query(`INSERT INTO app.workspace_memberships VALUES ($1, $2, 'owner')`, [workspace, user]);
    await client.query(
      `CREATE SCHEMA business; CREATE TABLE business."odd-name" (value text); INSERT INTO business."odd-name" VALUES ('private-record')`,
    );
    await client.query(
      `INSERT INTO database_management.migrations (name, checksum) VALUES ('private-ledger-name', 'private-ledger-checksum')`,
    );
    const snapshot = (await client.query('SELECT to_jsonb(w) AS row FROM app.workspaces w')).rows;
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../src/cli.ts', import.meta.url)), 'workspace-inventory', '--env', 'local'],
      {
        env: { ...process.env, DATABASE_MIGRATION_URL: url.href },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(result.stdout);
    assert.deepEqual(inventory.workspaces, {
      total: '1',
      ready: '1',
      soul_references: '1',
      standard_initial_keys: '1',
      production_bucket_references: '1',
    });
    assert.deepEqual(inventory.memberships, [{ role: 'owner', rows: '1' }]);
    assert.deepEqual(
      inventory.tables.find(row => row.schema === 'business'),
      { schema: 'business', name: 'odd-name', kind: 'r', rows: '1' },
    );
    assert.deepEqual((await client.query('SELECT to_jsonb(w) AS row FROM app.workspaces w')).rows, snapshot);
    for (const value of [
      user,
      workspace,
      'private-name',
      'private@example.invalid',
      'private-workspace',
      'private-slug',
      'private-record',
      'private-ledger-name',
      'private-ledger-checksum',
      url.href,
    ]) {
      assert.equal(result.stdout.includes(value), false, `inventory leaked ${value}`);
    }
    await admin.query(`CREATE ROLE ${escapeIdentifier(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA app, business, database_management TO ${escapeIdentifier(role)};
      GRANT SELECT ON ALL TABLES IN SCHEMA app, business, database_management TO ${escapeIdentifier(role)};
      REVOKE SELECT ON app.users FROM ${escapeIdentifier(role)}; GRANT SELECT (id) ON app.users TO ${escapeIdentifier(role)};
      SET ROLE ${escapeIdentifier(role)}`);
    const restrictedInventory = await workspaceStorageInventory(client);
    assert.deepEqual(
      restrictedInventory.columns.filter(column => column.table_name === 'users').map(column => column.column_name),
      ['id', 'name', 'email', 'email_verified', 'image', 'created_at', 'updated_at'],
    );
    await client.query(`RESET ROLE;
      ALTER TABLE app.workspaces OWNER TO ${escapeIdentifier(role)};
      ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY; ALTER TABLE app.workspaces FORCE ROW LEVEL SECURITY;
      SET ROLE ${escapeIdentifier(role)}`);
    await assert.rejects(workspaceStorageInventory(client), { code: '42501' });
    await client.query('RESET ROLE');
    assert.deepEqual((await client.query('SELECT to_jsonb(w) AS row FROM app.workspaces w')).rows, snapshot);
  } finally {
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)}`);
    await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
    await admin.end();
  }
});
