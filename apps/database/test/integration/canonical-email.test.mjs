import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { connect } from '../../src/postgres.ts';
import { canonicalEmail, canonicalEmailSql } from '../../../../packages/workspaces/src/canonical-email.ts';

const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

test('canonical email is unique and the SQL expression matches the TypeScript helper', { timeout: 30000 }, async () => {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL, 'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server');
  const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
  const name = `canonical_email_test_${randomUUID().replaceAll('-', '')}`;
  let client;
  try {
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
    url.pathname = `/${name}`;
    client = await connect(url.href);
    await client.query(`CREATE SCHEMA app; SET search_path TO app;\n${await migration('0001_baseline.sql')}`);
    await client.query(
      "INSERT INTO users (name, email, email_verified, canonical_email) VALUES ('Person', 'ab@gmail.com', true, 'ab@gmail.com')",
    );
    await assert.rejects(
      client.query(
        "INSERT INTO users (name, email, email_verified, canonical_email) VALUES ('Alias', 'ab+2@gmail.com', true, 'ab@gmail.com')",
      ),
      { code: '23505' },
    );

    for (const address of [
      'ab@gmail.com',
      'ab+1@gmail.com',
      'a.b@googlemail.com',
      '+tag@gmail.com',
      '...@gmail.com',
      'a+1@company.com',
      'a@gmail.com@other.test',
      'no-at-sign',
      'a@gmail.com.evil.test',
    ]) {
      const sql = (await client.query(`SELECT ${canonicalEmailSql('$1::text')} AS canonical`, [address])).rows[0]
        .canonical;
      assert.equal(sql, canonicalEmail(address), address);
    }
  } finally {
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
    await admin.end();
  }
});
