import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { createAuth } from '../src/auth.ts';
import { buildApp } from '../src/app.ts';
import { decryptEmailDelivery } from '@tulipfarm/workspaces/email-delivery';
import Fastify from 'fastify';
import { registerViewer } from '../src/viewer.ts';
import { registerSecurity } from '../src/security.ts';
import { authConfig } from '../src/auth.ts';

// The app serves the shipped model catalog, which needs a provider key.
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const originalDatabaseURL = process.env.DATABASE_URL;
const database = `auth_test_${randomUUID().replaceAll('-', '')}`;
const adminURL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres';
const admin = new Pool({ connectionString: adminURL });
before(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(adminURL);
  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.href;
  const setup = new Pool({ connectionString: url.href });
  try {
    await setup.query('CREATE SCHEMA app; SET search_path TO app');
    for (const name of ['0001_baseline.sql']) {
      await setup.query(await readFile(new URL(`../../database/migrations/${name}`, import.meta.url), 'utf8'));
    }
  } finally {
    await setup.end();
  }
});
after(async () => {
  if (originalDatabaseURL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseURL;
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

test('direct auth and HTTP reject unverified challenges without storing or delivering a magic link', async t => {
  const env = { ...process.env };
  Object.assign(process.env, { TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret' });
  t.after(() => {
    process.env = env;
  });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app' });
  const sent = [];
  const auth = createAuth(pool, async message => sent.push(message));
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ success: false }));
  const app = buildApp({ agentModel: null });
  const email = `rejected-${randomUUID()}@example.com`;
  try {
    for (const token of [null, 'invalid-token']) {
      const headers = {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        ...(token ? { 'x-captcha-response': token } : {}),
      };
      const direct = await auth.handler(
        new Request('http://localhost:3001/v1/auth/sign-in/magic-link', {
          method: 'POST',
          headers,
          body: JSON.stringify({ email }),
        }),
      );
      assert.equal(direct.status, 403);
      assert.equal((await direct.json()).code, 'CHALLENGE_FAILED');
      const http = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in/magic-link',
        headers,
        payload: { email },
      });
      assert.equal(http.statusCode, 403);
      assert.equal(http.json().code, 'CHALLENGE_FAILED');
    }
    assert.equal(sent.length, 0);
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(
      (await pool.query("SELECT id FROM verifications WHERE value::jsonb->>'email' = $1", [email])).rowCount,
      0,
    );
    assert.equal((await pool.query('SELECT id FROM email_deliveries')).rowCount, 0);
  } finally {
    await app.close();
    await pool.end();
  }
});

test('magic links create a session, reject replay and expiry, and sign out', async t => {
  const env = { ...process.env };
  Object.assign(process.env, { TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret' });
  t.after(() => {
    process.env = env;
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ success: true, hostname: 'localhost', action: 'sign_in' }),
  );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://tulipfarm:local-tulipfarm@127.0.0.1:5432/tulipfarm',
    options: '-c search_path=app',
  });
  const email = `auth-${randomUUID()}@example.com`;
  const sent = [];
  const auth = createAuth(pool, async message => {
    sent.push(message);
  });
  const origin = 'http://localhost:5173';
  const request = (path, body, cookie) =>
    auth.handler(
      new Request(`http://localhost:3001/v1/auth${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin,
          'x-captcha-response': 'fixture-token',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  try {
    const migration = await getMigrations(auth.options);
    assert.equal(await migration.compileMigrations(), ';');
    const send = await request('/sign-in/magic-link', {
      email,
      name: 'Auth test',
      callbackURL: `${origin}/example`,
      newUserCallbackURL: `${origin}/create-workspace`,
    });
    assert.equal(send.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].email, email);
    const url = new URL(sent[0].url);
    const stored = await pool.query("SELECT identifier FROM verifications WHERE value::jsonb->>'email' = $1", [email]);
    assert.equal(stored.rowCount, 1);
    assert.notEqual(stored.rows[0].identifier, url.searchParams.get('token'));
    const verified = await auth.handler(new Request(url));
    assert.equal(verified.status, 302);
    assert.equal(verified.headers.get('location'), `${origin}/create-workspace`);
    const cookie = verified.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    assert.match(cookie, /session_token=/);
    assert.match(verified.headers.get('set-cookie'), /httponly/i);
    const session = await (await request('/get-session', undefined, cookie)).json();
    assert.equal(session.user.email, email);
    assert.equal(session.user.emailVerified, true);
    assert.equal(session.user.name, 'Auth test');
    const viewer = Fastify();
    registerSecurity(viewer, origin);
    viewer.register(async routes => registerViewer(routes, auth), { prefix: '/v1' });
    t.after(() => viewer.close());
    const view = (sessionCookie = cookie) =>
      viewer.inject({
        url: '/v1/viewer',
        headers: { origin: authConfig().websiteOrigin, cookie: sessionCookie },
      });
    assert.deepEqual((await view()).json(), {
      authenticated: true,
      user: { name: 'Auth test', email, image: null },
      appUrl: `${origin}/`,
    });
    assert.deepEqual((await view('')).json(), { authenticated: false, user: null, appUrl: `${origin}/` });
    assert.equal((await view('better-auth.session_token=invalid')).json().authenticated, false);
    for (const name of ['', '   ', 'a'.repeat(81)]) {
      assert.equal(
        (await request('/update-user', { name }, cookie)).status,
        400,
        'Profile names must contain 1 to 80 non-whitespace characters',
      );
    }
    assert.equal((await request('/update-user', { name: '  Updated name  ' }, cookie)).status, 200);
    assert.equal((await (await request('/get-session', undefined, cookie)).json()).user.name, 'Updated name');
    assert.equal((await request('/update-user', { lastModelFamilyId: 'grok-fast' }, cookie)).status, 200);
    assert.equal((await (await request('/get-session', undefined, cookie)).json()).user.lastModelFamilyId, 'grok-fast');
    for (const lastModelFamilyId of ['not-a-model', '', 'a'.repeat(200), 42]) {
      assert.equal((await request('/update-user', { lastModelFamilyId }, cookie)).status, 400);
    }
    assert.equal((await (await request('/get-session', undefined, cookie)).json()).user.lastModelFamilyId, 'grok-fast');
    const replay = await auth.handler(new Request(url));
    assert.equal(new URL(replay.headers.get('location')).searchParams.get('error'), 'INVALID_TOKEN');
    const signOut = await request('/sign-out', {}, cookie);
    assert.equal(signOut.status, 200);
    assert.deepEqual((await view()).json(), { authenticated: false, user: null, appUrl: `${origin}/` });
    assert.equal(await (await request('/get-session', undefined, cookie)).json(), null);
    assert.equal((await request('/update-user', { name: 'Signed out' }, cookie)).status, 401);
    assert.equal((await request('/update-user', { lastModelFamilyId: 'claude-opus' }, cookie)).status, 401);

    await request('/sign-in/magic-link', { email, callbackURL: `${origin}/example` });
    await pool.query(
      "UPDATE verifications SET expires_at = now() - interval '1 second' WHERE value::jsonb->>'email' = $1",
      [email],
    );
    const expired = await auth.handler(new Request(sent[1].url));
    assert.equal(new URL(expired.headers.get('location')).searchParams.get('error'), 'INVALID_TOKEN');
    await request('/sign-in/magic-link', { email, callbackURL: `${origin}/example` });
    const unsafe = new URL(sent[2].url);
    unsafe.searchParams.set('callbackURL', 'https://example.org/steal');
    assert.equal((await auth.handler(new Request(unsafe))).status, 403);
    const existing = await auth.handler(new Request(sent[2].url));
    assert.equal(existing.headers.get('location'), `${origin}/example`);
    const returningCookie = existing.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    assert.equal(
      (await (await request('/get-session', undefined, returningCookie)).json()).user.lastModelFamilyId,
      'grok-fast',
    );
    await request('/sign-in/magic-link', { email: `other-${email}`, name: 'Other user', callbackURL: origin });
    const other = await auth.handler(new Request(sent[3].url));
    const otherCookie = other.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    assert.equal((await (await request('/get-session', undefined, otherCookie)).json()).user.lastModelFamilyId, null);
    assert.equal(
      (await request('/update-user', { lastModelFamilyId: 'claude-opus', userId: session.user.id }, otherCookie))
        .status,
      200,
    );
    assert.equal(
      (await (await request('/get-session', undefined, returningCookie)).json()).user.lastModelFamilyId,
      'grok-fast',
    );
    assert.equal(
      (await (await request('/get-session', undefined, otherCookie)).json()).user.lastModelFamilyId,
      'claude-opus',
    );
    assert.equal((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rowCount, 1);
  } finally {
    await pool.query("DELETE FROM verifications WHERE value::jsonb->>'email' = $1", [email]);
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    await pool.end();
  }
});

test('HTTP auth durably queues encrypted email and enforces origin checks', async t => {
  const oldEnv = { ...process.env };
  Object.assign(process.env, { TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret' });
  let verified = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (verified) return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    verified = true;
    return Response.json({ success: true, hostname: 'localhost', action: 'sign_in' });
  });
  const keys = { keyId: 'auth-test', key: randomBytes(32), previous: new Map() };
  process.env.EMAIL_DELIVERY_KEY_ID = keys.keyId;
  process.env.EMAIL_DELIVERY_KEY = keys.key.toString('hex');
  const app = buildApp({ agentModel: null });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://tulipfarm:local-tulipfarm@127.0.0.1:5432/tulipfarm',
  });
  const email = `dispatch-${randomUUID()}@example.com`;
  let deliveryId;
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/magic-link',
      headers: { origin: 'http://localhost:5173', 'x-captcha-response': 'single-use-token' },
      payload: { email, callbackURL: 'http://localhost:5173/example' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    const rows = (
      await pool.query("SELECT id, payload FROM app.email_deliveries WHERE kind = 'magic-link' AND payload IS NOT NULL")
    ).rows;
    const delivery = rows
      .map(row => ({ ...row, message: decryptEmailDelivery(row.id, row.payload, keys) }))
      .find(row => row.message.email === email);
    assert.ok(delivery, 'Email is durably queued before responding');
    deliveryId = delivery.id;
    assert.equal(JSON.stringify(delivery.payload).includes(email), false);
    const link = new URL(delivery.message.url);
    assert.equal(link.origin, 'http://localhost:5173');
    assert.equal(link.pathname, '/verify-email');
    assert.ok(link.searchParams.get('token'));
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/magic-link',
      headers: { origin: 'http://localhost:5173', 'x-captcha-response': 'single-use-token' },
      payload: { email },
    });
    assert.equal(replay.statusCode, 403);
    assert.equal(
      (await pool.query("SELECT id FROM app.verifications WHERE value::jsonb->>'email' = $1", [email])).rowCount,
      1,
    );
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/magic-link',
      headers: { origin: 'https://example.org' },
      payload: { email },
    });
    assert.equal(rejected.statusCode, 403);
  } finally {
    await app.close();
    try {
      if (deliveryId)
        await pool.query("UPDATE app.email_deliveries SET status = 'cancelled', payload = NULL WHERE id = $1", [
          deliveryId,
        ]);
      await pool.query("DELETE FROM app.verifications WHERE value::jsonb->>'email' = $1", [email]);
    } finally {
      await pool.end();
      process.env = oldEnv;
    }
  }
});

test('Gmail aliases of an existing account cannot sign up, while other domains keep plus addresses separate', async t => {
  const env = { ...process.env };
  Object.assign(process.env, { TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret' });
  t.after(() => {
    process.env = env;
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ success: true, hostname: 'localhost', action: 'sign_in' }),
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app' });
  const sent = [];
  const auth = createAuth(pool, async message => {
    sent.push(message);
  });
  const origin = 'http://localhost:5173';
  const signIn = email =>
    auth.handler(
      new Request('http://localhost:3001/v1/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { origin, 'x-captcha-response': 'fixture-token', 'content-type': 'application/json' },
        body: JSON.stringify({ email, name: 'Alias test', callbackURL: origin }),
      }),
    );
  const local = `ab${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const gmail = `${local}@gmail.com`;
  const company = `${local}@company.example`;
  try {
    assert.equal((await signIn(gmail)).status, 200);
    assert.equal((await auth.handler(new Request(sent.at(-1).url))).status, 302);
    assert.deepEqual((await pool.query('SELECT canonical_email FROM users WHERE email = $1', [gmail])).rows, [
      { canonical_email: gmail },
    ]);

    for (const alias of [
      `${local}+1@gmail.com`,
      `${local.slice(0, 1)}.${local.slice(1)}@gmail.com`,
      `${local}@googlemail.com`,
    ]) {
      const before = sent.length;
      const rejected = await signIn(alias);
      assert.equal(rejected.status, 409, alias);
      assert.equal((await rejected.json()).code, 'ACCOUNT_EXISTS');
      assert.equal(sent.length, before, 'No link is sent to an alias of an existing account');
    }
    const context = await auth.$context;
    await assert.rejects(
      context.internalAdapter.createUser({
        email: `${local}+google@gmail.com`,
        name: 'Google alias',
        emailVerified: true,
      }),
      error => error.body?.code === 'ACCOUNT_EXISTS',
    );
    assert.equal((await signIn(gmail)).status, 200, 'The original address still signs in');

    assert.equal((await signIn(company)).status, 200);
    assert.equal((await auth.handler(new Request(sent.at(-1).url))).status, 302);
    assert.equal(
      (await signIn(`${local}+1@company.example`)).status,
      200,
      'Plus addressing is not an alias outside Gmail',
    );
  } finally {
    await pool.query("DELETE FROM verifications WHERE value::jsonb->>'email' LIKE $1", [`%${local}%`]);
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${local}%`]);
    await pool.end();
  }
});

test('the per-recipient auth email limit is shared by Gmail aliases', async t => {
  const env = { ...process.env };
  Object.assign(process.env, { TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret' });
  const keys = { keyId: 'auth-alias-limit', key: randomBytes(32), previous: new Map() };
  process.env.EMAIL_DELIVERY_KEY_ID = keys.keyId;
  process.env.EMAIL_DELIVERY_KEY = keys.key.toString('hex');
  t.after(() => {
    process.env = env;
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ success: true, hostname: 'localhost', action: 'sign_in' }),
  );
  const app = buildApp({ agentModel: null });
  const local = `lim${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  try {
    const addresses = [
      `${local}@gmail.com`,
      `${local}+1@gmail.com`,
      `${local.slice(0, 1)}.${local.slice(1)}@googlemail.com`,
      `${local}+2@gmail.com`,
    ];
    const statuses = [];
    for (const [index, email] of addresses.entries()) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in/magic-link',
        remoteAddress: `10.74.2.${index + 1}`,
        headers: { origin: 'http://localhost:5173', 'x-captcha-response': 'fixture-token' },
        payload: { email },
      });
      statuses.push(response.statusCode);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  } finally {
    await app.close();
  }
});
