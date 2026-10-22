import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { escapeIdentifier } from 'pg';
import { extensionMigrations, loadExtensions, resetExtensions } from '@tulipfarm/extensions';
import { connect } from '../../src/postgres.ts';
import { migrate } from '../../src/migrations.ts';
import { DatabaseError } from '../../src/config.ts';

const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const fixture = new URL('../fixtures/ledger-extension.mjs', import.meta.url).href;

test(
  'extension migrations run after core in their own schema and ledger, idempotently',
  { timeout: 60000 },
  async t => {
    assert.ok(
      process.env.TEST_ADMIN_DATABASE_URL,
      'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server',
    );
    const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
    const name = `extension_migrations_${randomUUID().replaceAll('-', '')}`;
    let client;
    t.after(async () => {
      resetExtensions();
      await client?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
      await admin.end();
    });
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
    url.pathname = `/${name}`;
    client = await connect(url.href);

    assert.deepEqual(await loadExtensions([fixture], { app: 'database', env: {} }), ['fixture-ledger']);
    await migrate(client, directory);
    const ledger = async table =>
      (await client.query(`SELECT name, checksum, applied_at FROM ${table} ORDER BY name`)).rows;
    const core = await ledger('database_management.migrations');
    assert.deepEqual(
      core.map(row => row.name),
      ['0001_baseline.sql', '0002_model_bundles.sql'],
    );
    const own = await ledger('fixture_ledger.schema_migrations');
    assert.deepEqual(
      own.map(row => row.name),
      ['0001_entries.sql', '0002_owner.sql'],
    );
    // 0002 references app.users, so it can only succeed after core migrations.
    assert.deepEqual(
      (
        await client.query(`SELECT conrelid::regclass::text AS source, confrelid::regclass::text AS target
    FROM pg_constraint WHERE contype = 'f' AND conrelid = 'fixture_ledger.entries'::regclass`)
      ).rows,
      [{ source: 'fixture_ledger.entries', target: 'app.users' }],
    );
    assert.equal((await client.query("SELECT to_regclass('app.entries') AS relation")).rows[0].relation, null);

    await migrate(client, directory);
    assert.deepEqual(await ledger('database_management.migrations'), core);
    assert.deepEqual(await ledger('fixture_ledger.schema_migrations'), own);

    const [set] = extensionMigrations();
    const edited = [
      { ...set, migrations: [{ ...set.migrations[0], sql: `${set.migrations[0].sql}\nSELECT 1;` }, set.migrations[1]] },
    ];
    await assert.rejects(
      migrate(client, directory, edited),
      error => error instanceof DatabaseError && /extension schema "fixture_ledger"/.test(error.message),
    );
    const extended = [
      {
        ...set,
        migrations: [...set.migrations, { name: '0003_note.sql', sql: 'ALTER TABLE entries ADD COLUMN note text;' }],
      },
    ];
    await migrate(client, directory, extended);
    assert.deepEqual(
      (await ledger('fixture_ledger.schema_migrations')).map(row => row.name),
      ['0001_entries.sql', '0002_owner.sql', '0003_note.sql'],
    );
    assert.deepEqual(await ledger('database_management.migrations'), core);
  },
);
