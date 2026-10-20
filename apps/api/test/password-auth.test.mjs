import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { issuePasswordResetLink } from '../src/auth-reset-password.ts';
import { decryptEmailDelivery } from '@tulipfarm/workspaces/email-delivery';

const originalDatabaseURL = process.env.DATABASE_URL;
const database = `password_auth_test_${randomUUID().replaceAll('-', '')}`;
const adminURL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres';
const admin = new Pool({ connectionString: adminURL });
const origin = 'http://localhost:5173';
before(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(adminURL);
  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.href;
  const setup = new Pool({ connectionString: url.href });
  try {
    await setup.query('CREATE SCHEMA app; SET search_path TO app');
    for (const name of ['0001_baseline.sql', '0003_password_reset_email.sql']) {
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

// Requests come from a fresh client address unless a test picks one, so per-client limits stay out of the way.
let lastAddress = 0;
function clientAddress() {
  lastAddress++;
  return `10.37.${Math.floor(lastAddress / 250)}.${lastAddress % 250}`;
}

function setup(t, env) {
  const saved = { ...process.env };
  for (const name of ['AUTH_EMAIL_PASSWORD', 'EMAIL_PROVIDER', 'SMTP_HOST', 'ACS_CONNECTION_STRING']) {
    delete process.env[name];
  }
  Object.assign(process.env, { TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret', ...env });
  t.after(() => {
    process.env = saved;
  });
  const challenge = { pass: true };
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(challenge.pass ? { success: true, hostname: 'localhost', action: 'sign_in' } : { success: false }),
  );
  const app = buildApp();
  t.after(() => app.close());
  const post = (path, payload, cookie = '', remoteAddress = clientAddress()) =>
    app.inject({
      method: 'POST',
      url: `/v1/auth${path}`,
      remoteAddress,
      headers: { origin, 'x-captcha-response': 'fixture-token', ...(cookie ? { cookie } : {}) },
      payload,
    });
  const get = (path, cookie = '') =>
    app.inject({
      url: `/v1/auth${path}`,
      remoteAddress: clientAddress(),
      headers: { origin, ...(cookie ? { cookie } : {}) },
    });
  return { app, challenge, post, get };
}

function cookieOf(response) {
  const cookies = [response.headers['set-cookie'] ?? []].flat();
  return cookies.map(value => value.split(';')[0]).join('; ');
}

test('without AUTH_EMAIL_PASSWORD the options are unchanged and password routes are rejected', async t => {
  const { get, post } = setup(t, {});
  assert.deepEqual((await get('/options')).json(), { turnstileSiteKey: 'fixture-site' });
  const email = `off-${randomUUID()}@example.com`;
  const signUp = await post('/sign-up/email', { email, name: 'Off', password: 'correct horse battery' });
  assert.equal(signUp.statusCode, 400);
  assert.equal(signUp.json().code, 'EMAIL_PASSWORD_SIGN_UP_DISABLED');
  const signIn = await post('/sign-in/email', { email, password: 'correct horse battery' });
  assert.equal(signIn.statusCode, 400);
  assert.equal((await post('/request-password-reset', { email })).statusCode, 400);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app' });
  try {
    assert.equal((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rowCount, 0);
    await assert.rejects(issuePasswordResetLink(pool, email), /AUTH_EMAIL_PASSWORD=true/);
  } finally {
    await pool.end();
  }
});

test('AUTH_EMAIL_PASSWORD must be true or false', async t => {
  const saved = process.env.AUTH_EMAIL_PASSWORD;
  t.after(() => {
    if (saved === undefined) delete process.env.AUTH_EMAIL_PASSWORD;
    else process.env.AUTH_EMAIL_PASSWORD = saved;
  });
  process.env.AUTH_EMAIL_PASSWORD = 'yes';
  assert.throws(() => buildApp(), /AUTH_EMAIL_PASSWORD/);
});

test('password sign-up, sign-out, sign-in, change password and Turnstile without an email transport', async t => {
  const { get, post, challenge } = setup(t, { AUTH_EMAIL_PASSWORD: 'true' });
  assert.deepEqual((await get('/options')).json(), {
    turnstileSiteKey: 'fixture-site',
    emailPassword: true,
    passwordResetEmail: false,
  });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app' });
  t.after(() => pool.end());
  const migration = await getMigrations(createAuth(pool, async () => {}).options);
  assert.equal(await migration.compileMigrations(), ';', 'The baseline schema already has account.password');

  const email = `password-${randomUUID()}@example.com`;
  const password = 'correct horse battery';
  assert.equal(
    (await post('/sign-up/email', { email, name: 'Pat', password: 'short' })).json().code,
    'PASSWORD_TOO_SHORT',
  );
  challenge.pass = false;
  const challenged = await post('/sign-up/email', { email, name: 'Pat', password });
  assert.equal(challenged.statusCode, 403);
  assert.equal(challenged.json().code, 'CHALLENGE_FAILED');
  challenge.pass = true;

  const signUp = await post('/sign-up/email', { email, name: ' Pat ', password });
  assert.equal(signUp.statusCode, 200, signUp.body);
  const cookie = cookieOf(signUp);
  assert.match(cookie, /session_token=/);
  const session = (await get('/get-session', cookie)).json();
  assert.equal(session.user.email, email);
  assert.equal(session.user.name, 'Pat');
  assert.equal(session.user.emailVerified, false);
  const stored = await pool.query(
    "SELECT a.password FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1 AND a.provider_id = 'credential'",
    [email],
  );
  assert.equal(stored.rowCount, 1);
  assert.ok(stored.rows[0].password && !stored.rows[0].password.includes(password), 'Passwords are stored hashed');
  assert.equal((await post('/sign-up/email', { email, name: 'Again', password })).statusCode, 422);

  assert.equal((await post('/sign-out', {}, cookie)).statusCode, 200);
  assert.equal((await get('/get-session', cookie)).json(), null);

  const wrong = await post('/sign-in/email', { email, password: 'not the password' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().code, 'INVALID_EMAIL_OR_PASSWORD');
  const unknown = await post('/sign-in/email', { email: `nobody-${email}`, password });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.json().code, 'INVALID_EMAIL_OR_PASSWORD');
  challenge.pass = false;
  assert.equal((await post('/sign-in/email', { email, password })).statusCode, 403);
  challenge.pass = true;

  const signIn = await post('/sign-in/email', { email, password });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const signedIn = cookieOf(signIn);
  assert.equal((await get('/get-session', signedIn)).json().user.email, email);

  // No email transport: Better Auth refuses to email a reset link.
  assert.equal((await post('/request-password-reset', { email })).statusCode, 400);

  const second = cookieOf(await post('/sign-in/email', { email, password }));
  const badChange = await post(
    '/change-password',
    { currentPassword: 'not the password', newPassword: 'a brand new password' },
    signedIn,
  );
  assert.equal(badChange.statusCode, 400);
  assert.equal(badChange.json().code, 'INVALID_PASSWORD');
  const changed = await post(
    '/change-password',
    { currentPassword: password, newPassword: 'a brand new password', revokeOtherSessions: true },
    signedIn,
  );
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await get('/get-session', second)).json(), null, 'Other sessions are signed out');
  assert.equal((await post('/sign-in/email', { email, password })).statusCode, 401);
  assert.equal((await post('/sign-in/email', { email, password: 'a brand new password' })).statusCode, 200);
});

test('repeated password attempts for one address are rate limited, even with the right password', async t => {
  const { post } = setup(t, { AUTH_EMAIL_PASSWORD: 'true' });
  const email = `limited-${randomUUID()}@example.com`;
  const password = 'correct horse battery';
  assert.equal((await post('/sign-up/email', { email, name: 'Limited', password })).statusCode, 200);
  for (let attempt = 1; attempt < 10; attempt++) {
    assert.equal((await post('/sign-in/email', { email, password: `guess ${attempt}` })).statusCode, 401);
  }
  const limited = await post('/sign-in/email', { email, password });
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  const other = await post('/sign-up/email', { email: `other-${email}`, name: 'Other', password });
  assert.equal(other.statusCode, 200, 'The address limit does not block other addresses');

  const client = clientAddress();
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await post('/sign-in/email', { email: `${attempt}-${email}`, password }, '', client);
    assert.equal(response.statusCode, 401);
  }
  const busy = await post('/sign-in/email', { email: `other-${email}`, password }, '', client);
  assert.equal(busy.statusCode, 429, 'One client cannot try many addresses quickly');
});

test('the admin CLI link sets a password once, also for magic-link users, and signs out old sessions', async t => {
  const { post, get } = setup(t, { AUTH_EMAIL_PASSWORD: 'true' });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app' });
  t.after(() => pool.end());
  const email = `reset-${randomUUID()}@example.com`;
  const signUp = await post('/sign-up/email', { email, name: 'Reset', password: 'original password' });
  assert.equal(signUp.statusCode, 200, signUp.body);
  const oldSession = cookieOf(signUp);

  await assert.rejects(issuePasswordResetLink(pool, `missing-${email}`), /No account/);
  await assert.rejects(issuePasswordResetLink(pool, 'not an email'), /valid email/);
  const link = new URL(await issuePasswordResetLink(pool, ` ${email.toUpperCase()} `));
  assert.equal(link.origin, origin);
  assert.equal(link.pathname, '/login/reset-password');
  const token = link.searchParams.get('token');
  assert.ok(token);
  const userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  const stored = await pool.query('SELECT identifier FROM verifications WHERE value = $1', [userId]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].identifier.includes(token), false, 'Reset tokens are stored hashed');

  assert.equal((await post('/reset-password', { token, newPassword: 'short' })).statusCode, 400);
  const reset = await post('/reset-password', { token, newPassword: 'password from the cli' });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(
    (await post('/reset-password', { token, newPassword: 'another password' })).json().code,
    'INVALID_TOKEN',
  );
  assert.equal((await get('/get-session', oldSession)).json(), null);
  assert.equal((await post('/sign-in/email', { email, password: 'original password' })).statusCode, 401);
  assert.equal((await post('/sign-in/email', { email, password: 'password from the cli' })).statusCode, 200);

  // A magic-link user has no credential account until a reset link sets a password.
  const sent = [];
  const auth = createAuth(pool, async message => sent.push(message));
  const linkEmail = `link-${randomUUID()}@example.com`;
  await auth.api.signInMagicLink({
    headers: new Headers({ origin, 'x-captcha-response': 'fixture-token' }),
    body: { email: linkEmail, name: 'Link' },
  });
  await auth.handler(new Request(sent[0].url));
  assert.equal((await post('/sign-in/email', { email: linkEmail, password: 'password for link' })).statusCode, 401);
  const linkToken = new URL(await issuePasswordResetLink(pool, linkEmail)).searchParams.get('token');
  assert.equal((await post('/reset-password', { token: linkToken, newPassword: 'password for link' })).statusCode, 200);
  const linked = await post('/sign-in/email', { email: linkEmail, password: 'password for link' });
  assert.equal(linked.statusCode, 200);
  assert.equal((await get('/get-session', cookieOf(linked))).json().user.emailVerified, true);
});

test('with an email transport, forgot password queues an encrypted reset email whose link resets once', async t => {
  const keys = { keyId: 'password-test', key: randomBytes(32), previous: new Map() };
  const { get, post } = setup(t, {
    AUTH_EMAIL_PASSWORD: 'true',
    SMTP_HOST: 'mail.example.test',
    EMAIL_DELIVERY_KEY_ID: keys.keyId,
    EMAIL_DELIVERY_KEY: keys.key.toString('hex'),
  });
  assert.equal((await get('/options')).json().passwordResetEmail, true);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app' });
  t.after(() => pool.end());
  const email = `smtp-${randomUUID()}@example.com`;
  assert.equal((await post('/sign-up/email', { email, name: 'Mail', password: 'first password' })).statusCode, 200);

  const unknown = await post('/request-password-reset', { email: `nobody-${email}` });
  assert.equal(unknown.statusCode, 200, 'Unknown addresses get the same answer');
  const requested = await post('/request-password-reset', { email });
  assert.equal(requested.statusCode, 200, requested.body);
  const rows = (await pool.query("SELECT id, payload, expires_at FROM email_deliveries WHERE kind = 'password-reset'"))
    .rows;
  assert.equal(rows.length, 1, 'Only the known address gets an email');
  assert.equal(JSON.stringify(rows[0].payload).includes(email), false, 'The queued email is encrypted');
  const message = decryptEmailDelivery(rows[0].id, rows[0].payload, keys);
  assert.equal(message.kind, 'password-reset');
  assert.equal(message.email, email);
  const link = new URL(message.url);
  assert.equal(link.origin + link.pathname, `${origin}/login/reset-password`);
  const minutes = (new Date(rows[0].expires_at).getTime() - Date.now()) / 60_000;
  assert.ok(minutes > 55 && minutes <= 60, `Reset emails expire with the link, got ${minutes}`);

  const token = link.searchParams.get('token');
  assert.equal((await post('/reset-password', { token, newPassword: 'emailed password' })).statusCode, 200);
  assert.equal((await post('/reset-password', { token, newPassword: 'emailed password 2' })).statusCode, 400);
  assert.equal((await post('/sign-in/email', { email, password: 'first password' })).statusCode, 401);
  assert.equal((await post('/sign-in/email', { email, password: 'emailed password' })).statusCode, 200);
});
