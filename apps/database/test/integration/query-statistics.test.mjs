import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client, Pool } from 'pg';
import { restrictQueryStatistics } from '../../src/extensions.ts';

test('pg_stat_statements is readable only through pg_read_all_stats', async () => {
  const pool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
  const suffix = randomUUID().replaceAll('-', '');
  const database = `query_stats_${suffix}`;
  const role = `query_stats_${suffix}`;
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.href });
  const access = async () =>
    (
      await client.query(
        `SELECT has_table_privilege($1,'pg_stat_statements','SELECT') AS view,
        has_function_privilege($1,'pg_stat_statements(boolean)','EXECUTE') AS function,
        has_table_privilege('pg_read_all_stats','pg_stat_statements','SELECT') AS monitor`,
        [role],
      )
    ).rows[0];
  try {
    await pool.query(`CREATE DATABASE "${database}"`);
    await pool.query(`CREATE ROLE "${role}"`);
    await client.connect();
    await restrictQueryStatistics(client);
    await client.query('CREATE EXTENSION pg_stat_statements');
    assert.deepEqual(await access(), { view: true, function: true, monitor: true });
    await restrictQueryStatistics(client);
    await restrictQueryStatistics(client);
    assert.deepEqual(await access(), { view: false, function: false, monitor: true });
  } finally {
    await client.end();
    await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await pool.query(`DROP ROLE IF EXISTS "${role}"`);
    await pool.end();
  }
});
