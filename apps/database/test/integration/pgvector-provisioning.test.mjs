import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { installExtensions } from '../../src/extensions.ts';
import { provisionTestPgvector } from '../../../../packages/workspace-storage/test/integration/pgvector.fixture.mjs';

test('extension setup is idempotent and rejects an unqualified schema or version', async () => {
  const pool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
  const database = `pgvector_setup_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.href });
  try {
    await pool.query(`CREATE DATABASE "${database}"`);
    await provisionTestPgvector(pool, database);
    await client.connect();
    await installExtensions(client, false);
    await client.query('ALTER EXTENSION vector SET SCHEMA public');
    await assert.rejects(installExtensions(client, false), /requires an explicit upgrade/);
    await client.query('ALTER EXTENSION vector SET SCHEMA extensions');
    const version = (await client.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0]
      .extversion;
    await client.query("UPDATE pg_extension SET extversion='0.7.4' WHERE extname='vector'");
    await assert.rejects(installExtensions(client, false), /requires an explicit upgrade/);
    await client.query("UPDATE pg_extension SET extversion=$1 WHERE extname='vector'", [version]);
    await installExtensions(client, false);
  } finally {
    await client.end();
    await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await pool.end();
  }
});

test('pgvector grants preserve the real restricted release provisioner boundary', () => {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL);
  const child = spawnSync(
    process.execPath,
    ['apps/database/test/qualification-release-provisioner.mjs', 'local', '--create-disposable-database'],
    {
      env: { ...process.env, DATABASE_ADMIN_URL: process.env.TEST_ADMIN_DATABASE_URL },
      encoding: 'utf8',
      timeout: 90000,
    },
  );
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /actual postuse ownership and membership inspection/);
  assert.match(child.stdout, /"status":"PASS"/);
  process.stdout.write(child.stdout);
});
