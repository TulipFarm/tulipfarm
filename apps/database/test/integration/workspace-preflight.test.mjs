import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { connect } from '../../src/postgres.ts';
import { workspaceStoragePreflight } from '../../src/workspace-preflight.ts';

test('fresh cutover preserves identities and refuses unexpected workspace data without deleting it', async () => {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL, 'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server');
  const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
  const name = `preflight_${randomUUID().replaceAll('-', '')}`;
  const role = `${name}_owner`;
  let client;
  try {
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
    url.pathname = `/${name}`;
    client = await connect(url.href);
    await client.query(
      "CREATE SCHEMA app; CREATE TABLE app.identities (id text PRIMARY KEY); INSERT INTO app.identities VALUES ('retained-user'); CREATE TABLE app.workspaces (id text PRIMARY KEY)",
    );
    assert.deepEqual(await workspaceStoragePreflight(client), {
      status: 'fresh-workspace-installation',
      identityPreserved: true,
    });
    await client.query("INSERT INTO app.workspaces VALUES ('unexpected-workspace')");
    await assert.rejects(workspaceStoragePreflight(client), /preservation plan/);
    assert.deepEqual((await client.query('SELECT id FROM app.workspaces')).rows, [{ id: 'unexpected-workspace' }]);
    assert.deepEqual((await client.query('SELECT id FROM app.identities')).rows, [{ id: 'retained-user' }]);
    await client.query('DELETE FROM app.workspaces; CREATE SCHEMA ws_existing');
    await assert.rejects(workspaceStoragePreflight(client), /reconciliation/);
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'ws_existing'")).rows[0].n,
      1,
    );
    await client.query('DROP SCHEMA ws_existing');
    await admin.query(`CREATE ROLE ${escapeIdentifier(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(
      `GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(role)}; ALTER TABLE app.workspaces OWNER TO ${escapeIdentifier(role)}; INSERT INTO app.workspaces VALUES ('hidden-workspace'); ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY; ALTER TABLE app.workspaces FORCE ROW LEVEL SECURITY; SET ROLE ${escapeIdentifier(role)}`,
    );
    assert.equal((await client.query('SELECT * FROM app.workspaces')).rowCount, 0);
    await assert.rejects(workspaceStoragePreflight(client), { code: '42501' });
    await client.query('RESET ROLE');
    assert.deepEqual((await client.query('SELECT id FROM app.workspaces')).rows, [{ id: 'hidden-workspace' }]);
  } finally {
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)}`);
    await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
    await admin.end();
  }
});
