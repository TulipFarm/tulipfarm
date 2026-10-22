import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { createAuth } from '../src/auth.ts';
import { registerUserVisits } from '../src/user-visits.ts';
import { grantApplicationAccess } from '../../database/src/postgres.ts';

test('per-user welcome survives retries, sessions, account switches, and migration with real auth', async () => {
  const database = `visits_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
  url.pathname = `/${database}`;
  let owner, pool, app;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    owner = new Pool({ connectionString: url.href, options: '-c search_path=app' });
    await owner.query('CREATE SCHEMA app');
    for (const file of ['0001_baseline.sql'])
      await owner.query(await readFile(new URL(`../../database/migrations/${file}`, import.meta.url), 'utf8'));
    const oldUser = randomUUID();
    await owner.query('INSERT INTO users (id,name,email,email_verified) VALUES ($1,$2,$3,true)', [
      oldUser,
      'Existing user',
      'existing@example.test',
    ]);
    await owner.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    await admin.query('CREATE ROLE tulipfarm LOGIN');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await grantApplicationAccess(client, 'disabled');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    url.username = 'tulipfarm';
    url.password = '';
    pool = new Pool({ connectionString: url.href, options: '-c search_path=app' });
    const links = [];
    const auth = createAuth(
      pool,
      async ({ url }) => links.push(url),
      async () => {},
    );
    app = Fastify();
    registerUserVisits(app, { auth, pool }, 'http://localhost:5173');
    async function signIn(email) {
      await auth.api.signInMagicLink({ headers: new Headers({ origin: 'http://localhost:5173' }), body: { email } });
      const response = await auth.handler(new Request(links.pop()));
      assert.equal(response.status, 302);
      return response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
    }
    const visit = (cookie, payload = {}) =>
      app.inject({ method: 'POST', url: '/user/visit', headers: { origin: 'http://localhost:5173', cookie }, payload });
    assert.equal((await visit('')).statusCode, 401);
    const first = await signIn('new@example.test');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/user/visit',
          headers: { origin: 'https://other.example', cookie: first },
        })
      ).statusCode,
      403,
    );
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM user_visits')).rows[0].count, 1);
    const responses = await Promise.all(Array.from({ length: 8 }, () => visit(first)));
    for (const response of responses) {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { firstSession: true });
    }
    const second = await signIn('new@example.test');
    assert.deepEqual((await visit(second)).json(), { firstSession: false });
    assert.deepEqual((await visit(first)).json(), { firstSession: true });
    const other = await signIn('other@example.test');
    assert.deepEqual((await visit(other, { userId: oldUser, firstSession: false })).json(), { firstSession: true });
    assert.deepEqual((await visit(await signIn('existing@example.test'))).json(), { firstSession: false });
    await auth.api.signOut({ headers: new Headers({ cookie: first }) });
    assert.equal((await visit(first)).statusCode, 401);
    assert.deepEqual((await visit(await signIn('new@example.test'))).json(), { firstSession: false });
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM user_visits')).rows[0].count, 3);
    await owner.query("DELETE FROM users WHERE email='new@example.test'");
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM user_visits')).rows[0].count, 2);
  } finally {
    await app?.close();
    await pool?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.query('DROP ROLE IF EXISTS tulipfarm');
    await admin.end();
  }
});
