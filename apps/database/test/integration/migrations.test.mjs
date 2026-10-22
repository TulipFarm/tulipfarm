import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { connect } from '../../src/postgres.ts';
import { migrate } from '../../src/migrations.ts';
import { DatabaseError } from '../../src/config.ts';

test(
  'migrations serialize concurrent runners, roll back failures, and reject history edits',
  { timeout: 30000 },
  async () => {
    assert.ok(
      process.env.TEST_ADMIN_DATABASE_URL,
      'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server',
    );
    const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
    const name = `migration_test_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(tmpdir(), 'tulipfarm-db-test-'));
    const clients = [];
    try {
      await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
      const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
      url.pathname = `/${name}`;
      clients.push(await connect(url.href), await connect(url.href));
      await writeFile(
        join(directory, '0001_records.sql'),
        'CREATE SCHEMA app; CREATE TABLE app.records (id integer PRIMARY KEY); INSERT INTO app.records VALUES (42);',
      );
      await Promise.all(clients.map(client => migrate(client, directory)));
      const rows = await clients[0].query('SELECT id FROM app.records');
      assert.deepEqual(rows.rows, [{ id: 42 }]);
      assert.equal((await clients[0].query('SELECT * FROM database_management.migrations')).rowCount, 1);
      await writeFile(join(directory, '0002_success.sql'), 'INSERT INTO records VALUES (43);');
      await writeFile(
        join(directory, '0003_failure.sql'),
        'INSERT INTO records VALUES (44); SELECT nonexistent_column FROM records;',
      );
      await assert.rejects(migrate(clients[0], directory), { code: '42703' });
      assert.deepEqual((await clients[0].query('SELECT id FROM app.records ORDER BY id')).rows, [
        { id: 42 },
        { id: 43 },
      ]);
      assert.equal((await clients[0].query('SELECT * FROM database_management.migrations')).rowCount, 2);
      assert.equal((await clients[1].query('SELECT pg_try_advisory_lock(734128, 2) AS locked')).rows[0].locked, true);
      await clients[1].query('SELECT pg_advisory_unlock(734128, 2)');
      await writeFile(join(directory, '0001_records.sql'), 'SELECT 1;');
      await assert.rejects(
        migrate(clients[0], directory),
        error => error instanceof DatabaseError && /modified/.test(error.message),
      );
      await rm(join(directory, '0001_records.sql'));
      await assert.rejects(migrate(clients[0], directory), DatabaseError);
      await writeFile(
        join(directory, '0001_records.sql'),
        'CREATE SCHEMA app; CREATE TABLE app.records (id integer PRIMARY KEY); INSERT INTO app.records VALUES (42);',
      );
      await writeFile(join(directory, '0000_inserted.sql'), 'SELECT 1;');
      await assert.rejects(migrate(clients[0], directory), DatabaseError);
      await rm(join(directory, '0000_inserted.sql'));
      await writeFile(join(directory, '0003_failure.sql'), 'INSERT INTO records VALUES (44);');
      await migrate(clients[0], directory);
      await migrate(clients[1], directory);
      assert.deepEqual((await clients[0].query('SELECT id FROM app.records ORDER BY id')).rows, [
        { id: 42 },
        { id: 43 },
        { id: 44 },
      ]);
      assert.equal((await clients[0].query('SELECT * FROM database_management.migrations')).rowCount, 3);
    } finally {
      await Promise.all(clients.map(client => client.end()));
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)}`);
      await admin.end();
      await rm(directory, { recursive: true });
    }
  },
);
