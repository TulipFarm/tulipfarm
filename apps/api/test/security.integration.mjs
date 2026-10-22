import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool, escapeIdentifier } from 'pg';
import { createAbuseLimiter, registerAbuseHooks } from '../src/abuse.ts';
import Fastify from 'fastify';
import { buildApp } from '../src/app.ts';
import { decryptEmailDelivery } from '@tulipfarm/workspaces/email-delivery';
import { grantApplicationAccess } from '../../database/src/postgres.ts';

test('shared limits are atomic across replicas, expire, and protect real auth requests', async t => {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL, 'Set TEST_ADMIN_DATABASE_URL to disposable local PostgreSQL');
  const old = { ...process.env };
  const admin = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
  const name = `api_security_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  const pools = [
    new Pool({ connectionString: url.href, options: '-c search_path=app' }),
    new Pool({ connectionString: url.href }),
  ];
  const apps = [];
  t.after(async () => {
    await Promise.all(apps.map(app => app.close()));
    await Promise.all(pools.map(pool => pool.end()));
    await admin.query(`DROP DATABASE ${escapeIdentifier(name)}`);
    await admin.end();
    process.env = old;
  });
  for (const file of ['0001_baseline.sql']) {
    await pools[0].query(await readFile(new URL(`../../database/migrations/${file}`, import.meta.url), 'utf8'));
  }
  await pools[0].query('BEGIN');
  await grantApplicationAccess(pools[0], 'disabled');
  await pools[0].query('COMMIT');
  const restricted = new Pool({ connectionString: url.href, options: '-c role=tulipfarm' });
  pools.push(restricted);
  assert.equal(
    await createAbuseLimiter(restricted, 'restricted-role-secret')(
      { name: 'role-test', max: 1, windowMs: 60_000 },
      'identity',
    ),
    null,
  );
  await restricted.query('DELETE FROM app.api_rate_limits');
  const limiters = pools.map(pool => createAbuseLimiter(pool, 'integration-test-secret'));
  const policy = { name: 'concurrent', max: 5, windowMs: 60_000 };
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, index) => limiters[index % 2](policy, 'private@example.com')),
  );
  assert.equal(results.filter(result => result === null).length, 5);
  assert.equal(results.filter(result => result > 0 && result <= 60).length, 25);
  const rows = (await pools[0].query('SELECT * FROM app.api_rate_limits')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hits, 6);
  assert.match(rows[0].key, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(rows).includes('private@example.com'));
  await pools[0].query("UPDATE app.api_rate_limits SET expires_at = now() - interval '1 second'");
  assert.equal(await limiters[1](policy, 'private@example.com'), null);
  assert.equal(await limiters[0](policy, 'another@example.com'), null);
  assert.equal(await limiters[0]({ ...policy, name: 'independent' }, 'private@example.com'), null);

  const invitationApps = [Fastify(), Fastify()];
  t.after(async () => {
    await Promise.all(invitationApps.map(app => app.close()));
  });
  for (const [index, app] of invitationApps.entries()) {
    registerAbuseHooks(app, limiters[index], { api: { getSession: async () => ({ user: { id: 'batch-admin' } }) } });
    app.post('/invitations', { schema: { operationId: 'createGovernanceInvitationV1' } }, request => ({
      email: request.body.email,
    }));
    app.post('/resend', { schema: { operationId: 'resendGovernanceInvitationV1' } }, () => ({ sent: true }));
  }
  const batchResults = await Promise.all(
    Array.from({ length: 21 }, (_, index) =>
      invitationApps[index % 2].inject({
        method: 'POST',
        url: '/invitations',
        payload: { email: `recipient-${index}@example.com` },
      }),
    ),
  );
  assert.equal(batchResults.filter(response => response.statusCode === 200).length, 20);
  assert.equal(batchResults.filter(response => response.statusCode === 429).length, 1);
  assert.ok(Number(batchResults.find(response => response.statusCode === 429).headers['retry-after']) > 3500);
  assert.equal((await invitationApps[0].inject({ method: 'POST', url: '/resend' })).statusCode, 429);

  process.env.DATABASE_URL = url.href;
  process.env.NODE_ENV = 'test';
  process.env.WORKSPACE_STORAGE_CAPABILITY = 'disabled';
  process.env.EMAIL_DELIVERY_KEY_ID = 'test';
  process.env.EMAIL_DELIVERY_KEY = 'ab'.repeat(32);
  process.env.API_PROXY_MODE = 'azure-container-apps';
  process.env.BETTER_AUTH_SECRET = 'integration-auth-secret-with-at-least-32-characters';
  process.env.WEB_ORIGIN = 'http://localhost:5173';
  process.env.BETTER_AUTH_URL = 'http://localhost:3001';
  process.env.TURNSTILE_SITE_KEY = 'security-test-site';
  process.env.TURNSTILE_SECRET_KEY = 'security-test-secret';
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    return Response.json({ success: true, hostname: 'localhost', action: 'sign_in' });
  });
  apps.push(buildApp(), buildApp());
  for (let index = 0; index < 4; index++) {
    const result = await apps[index % 2].inject({
      method: 'POST',
      url: '/v1/auth/sign-in/magic-link',
      headers: {
        origin: 'http://localhost:5173',
        'x-forwarded-for': `192.0.2.${index + 1}`,
        'x-captcha-response': 'test-token',
      },
      payload: { email: index % 2 ? 'Recipient@example.com' : 'recipient@example.com' },
    });
    assert.equal(result.statusCode, index < 3 ? 200 : 429, result.body);
    if (index === 3) assert.ok(Number(result.headers['retry-after']) > 0);
  }
  assert.equal((await pools[0].query('SELECT * FROM app.email_deliveries')).rowCount, 3);
  const delivery = (await pools[0].query('SELECT id, payload FROM app.email_deliveries ORDER BY created_at LIMIT 1'))
    .rows[0];
  const message = decryptEmailDelivery(delivery.id, delivery.payload, {
    keyId: 'test',
    key: Buffer.from('ab'.repeat(32), 'hex'),
    previous: new Map(),
  });
  const verified = await apps[0].inject({
    url: `/v1/auth/magic-link/verify${new URL(message.url).search}`,
    headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.20', 'x-tulipfarm-client-ip': '203.0.113.99' },
  });
  assert.equal(verified.statusCode, 302);
  assert.match(String(verified.headers['set-cookie']), /HttpOnly/i);
  assert.equal((await pools[0].query('SELECT ip_address FROM app.sessions')).rows[0].ip_address, '198.51.100.20');
  const oversized = await apps[0].inject({
    method: 'POST',
    url: '/v1/auth/sign-in/magic-link',
    headers: { origin: 'http://localhost:5173' },
    payload: { email: 'another@example.com', metadata: 'x'.repeat(16_384) },
  });
  assert.equal(oversized.statusCode, 413);
  for (let index = 0; index < 6; index++) {
    const result = await apps[index % 2].inject({
      method: 'POST',
      url: '/v1/auth/sign-in/magic-link',
      headers: {
        origin: 'http://localhost:5173',
        'x-forwarded-for': `203.0.113.${index}, 198.51.100.10`,
        'x-captcha-response': 'test-token',
      },
      payload: { email: `different-${index}@example.com` },
    });
    assert.equal(result.statusCode, index < 5 ? 200 : 429, result.body);
  }
  await pools[0].query('DROP TABLE app.api_rate_limits');
  const unavailable = await apps[0].inject('/v1/auth/get-session');
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { error: 'abuse-protection-unavailable' });
  assert.equal((await apps[0].inject('/v1/health/live')).statusCode, 200);
});
