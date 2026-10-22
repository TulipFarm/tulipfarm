import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { connect } from '../../src/postgres.ts';
import { migrate } from '../../src/migrations.ts';

const bundleId = `server-${'a'.repeat(64)}`;
const payload = JSON.stringify({ id: bundleId, format: 1 });

test(
  '0002 upgrades the baseline to an append-only server bundle registry behind two routines',
  { timeout: 60000 },
  async () => {
    assert.ok(
      process.env.TEST_ADMIN_DATABASE_URL,
      'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server',
    );
    const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
    const name = `model_bundles_${randomUUID().replaceAll('-', '')}`;
    const role = `registry_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(tmpdir(), 'tulipfarm-model-bundles-'));
    let client;
    try {
      await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
      const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
      url.pathname = `/${name}`;
      client = await connect(url.href);
      await client.query(
        `REVOKE ALL ON DATABASE ${escapeIdentifier(name)} FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
      );
      const migrations = new URL('../../migrations/', import.meta.url);
      const copy = async file => writeFile(join(directory, file), await readFile(new URL(file, migrations), 'utf8'));
      await copy('0001_baseline.sql');
      await migrate(client, directory);
      await provisionTableRegistry(client, {
        capability: 'authoring',
        role,
        password: randomBytes(32).toString('hex'),
      });
      await client.query("INSERT INTO model_lifecycle.identities (kind, id, value) VALUES ('model', 'retired', '{}')");

      await copy('0002_model_bundles.sql');
      await migrate(client, directory);
      assert.deepEqual(
        (
          await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'model_lifecycle' AND c.relkind IN ('r', 'v') ORDER BY 1`)
        ).rows,
        [{ relname: 'bundles' }],
      );

      const register = (id, body) => client.query('SELECT app.register_model_bundle($1, $2::jsonb)', [id, body]);
      await register(bundleId, payload);
      await register(bundleId, JSON.stringify({ format: 1, id: bundleId }));
      assert.deepEqual(
        (await client.query('SELECT app.model_bundle($1) AS payload', [bundleId])).rows[0].payload,
        JSON.parse(payload),
      );
      assert.equal((await client.query("SELECT app.model_bundle('server-unknown') AS payload")).rows[0].payload, null);
      await assert.rejects(register(bundleId, JSON.stringify({ id: bundleId, format: 2 })), /identity conflict/);
      await assert.rejects(register(`server-${'b'.repeat(64)}`, payload), /bundles_id/);
      await assert.rejects(register('forged', JSON.stringify({ id: 'forged' })), /bundles_id/);
      await assert.rejects(client.query('DELETE FROM model_lifecycle.bundles'), /immutable/);

      const access = async grantee =>
        (
          await client.query(
            `SELECT has_schema_privilege($1, 'model_lifecycle', 'USAGE') AS schema,
      has_function_privilege($1, 'app.register_model_bundle(text,jsonb)', 'EXECUTE') AS register,
      has_function_privilege($1, 'app.model_bundle(text)', 'EXECUTE') AS read`,
            [grantee],
          )
        ).rows[0];
      assert.deepEqual(await access(role), { schema: false, register: true, read: true });
      assert.deepEqual(await access('public'), { schema: false, register: false, read: false });
      if ((await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'tulipfarm'")).rowCount) {
        assert.deepEqual(await access('tulipfarm'), { schema: false, register: true, read: true });
      }
      // The registry login's privilege boundary still holds with the routines granted.
      await provisionTableRegistry(client, {
        capability: 'authoring',
        role,
        password: randomBytes(32).toString('hex'),
      });
    } finally {
      await client?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
