import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { connect } from '../../src/postgres.ts';
import { migrate } from '../../src/migrations.ts';

test(
  'the worker authoring login reads flag targeting attributes only through the narrow routine',
  { timeout: 60000 },
  async () => {
    assert.ok(
      process.env.TEST_ADMIN_DATABASE_URL,
      'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server',
    );
    const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
    const name = `flag_context_${randomUUID().replaceAll('-', '')}`;
    const registry = {
      capability: 'authoring',
      role: `registry_${randomUUID().replaceAll('-', '')}`,
      password: randomBytes(32).toString('hex'),
    };
    let client;
    let worker;
    try {
      await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
      const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
      url.pathname = `/${name}`;
      client = await connect(url.href);
      await client.query(
        `REVOKE ALL ON DATABASE ${escapeIdentifier(name)} FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
      );
      await migrate(client, fileURLToPath(new URL('../../migrations/', import.meta.url)));
      await provisionTableRegistry(client, registry);

      const userId = randomUUID();
      const workspaceId = randomUUID();
      await client.query(
        `INSERT INTO app.users (id, name, email, email_verified) VALUES ($1, 'Ada', 'ada@example.test', true)`,
        [userId],
      );
      await client.query(
        `INSERT INTO app.workspaces (id, request_id, created_by, name, creation_name, slug, created_at)
       VALUES ($1, $2, $3, 'Acme', 'Acme', 'acme', '2026-01-01T00:00:00Z')`,
        [workspaceId, randomUUID(), userId],
      );

      url.username = registry.role;
      url.password = registry.password;
      worker = await connect(url.href);
      const read = id => worker.query('SELECT slug, name, created_at FROM app.workspace_flag_context($1)', [id]);
      const [row] = (await read(workspaceId)).rows;
      assert.deepEqual(
        { ...row, created_at: row.created_at.toISOString() },
        {
          slug: 'acme',
          name: 'Acme',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      );
      assert.deepEqual((await read(randomUUID())).rows, []);
      await assert.rejects(worker.query('SELECT name, slug FROM app.workspaces'), /permission denied/);
      await assert.rejects(worker.query('SELECT email FROM app.users'), /permission denied/);
      assert.equal(
        (
          await client.query(
            `SELECT has_function_privilege('public', 'app.workspace_flag_context(uuid)', 'EXECUTE') AS run`,
          )
        ).rows[0].run,
        false,
      );
    } finally {
      await worker?.end();
      await client?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(registry.role)}`);
      await admin.end();
    }
  },
);
