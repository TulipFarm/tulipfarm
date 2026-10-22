import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool, escapeIdentifier } from 'pg';
import { readMigrations } from '../../database/src/migrations.ts';
import { createAuth } from '../src/auth.ts';
import { registerSecurity } from '../src/security.ts';
import { registerPublicGuide } from '../src/public-guide.ts';
import { guideAccess } from '../src/public-guide-access.ts';
import { guideDailyTurns, guideLimits } from '../src/public-guide-config.ts';
import { resumeOnboarding } from '@tulipfarm/workspaces/onboarding';

test(
  'public guide shares daily and concurrency budgets across replicas, and bridges real verified signup',
  { timeout: 60000 },
  async t => {
    const oldEnv = { ...process.env };
    const admin = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    const database = `public_guide_${randomUUID().replaceAll('-', '')}`;
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='tulipfarm') THEN CREATE ROLE tulipfarm; END IF; END $$`,
    );
    await admin.query(`CREATE DATABASE ${escapeIdentifier(database)}`);
    const url = new URL(admin.options.connectionString);
    url.pathname = `/${database}`;
    const first = new Pool({ connectionString: url.href, max: 12, options: '-c search_path=app' });
    const second = new Pool({ connectionString: url.href, max: 12, options: '-c search_path=app' });
    let app;
    const releases = [];
    t.after(async () => {
      for (const release of releases) await release();
      await app?.close();
      await first.end();
      await second.end();
      await admin.query(`DROP DATABASE ${escapeIdentifier(database)}`);
      await admin.end();
      process.env = oldEnv;
    });
    for (const migration of await readMigrations(fileURLToPath(new URL('../../database/migrations', import.meta.url))))
      await first.query(migration.sql);
    const secret = 'guide-integration-signing-secret';
    const a = guideAccess(first, secret);
    const b = guideAccess(second, secret);
    const id = randomUUID();
    const held = await a.turn('192.0.2.1', id, new AbortController());
    releases.push(held);
    await assert.rejects(b.turn('192.0.2.2', id, new AbortController()), /already-answering/);
    for (let index = 1; index < guideLimits.concurrent; index++) {
      releases.push(await (index % 2 ? a : b).turn(`192.0.2.${index + 10}`, randomUUID(), new AbortController()));
    }
    await assert.rejects(b.turn('192.0.2.50', randomUUID(), new AbortController()), /guide-busy/);
    for (const release of releases) await release();
    releases.push(await b.turn('192.0.2.51', randomUUID(), new AbortController()));
    await releases.at(-1)();
    const costKey = createHmac('sha256', secret).update('public-guide-cost-day:all').digest('hex');
    await first.query('UPDATE app.api_rate_limits SET hits = $2 WHERE key = $1', [costKey, guideDailyTurns]);
    await assert.rejects(
      a.turn('192.0.2.60', randomUUID(), new AbortController()),
      error => error.statusCode === 429 && error.retryAfter > 0,
    );
    await first.query('DELETE FROM app.api_rate_limits');
    for (let i = 0; i < 5; i++) await a.session('192.0.2.80');
    await assert.rejects(b.session('192.0.2.80'), error => error.statusCode === 429);
    await first.query('DELETE FROM app.api_rate_limits');
    for (let i = 0; i < 30; i++) {
      // Expire only the minute bucket; the daily bucket survives both processes.
      await first.query(
        "UPDATE app.api_rate_limits SET expires_at = now() WHERE expires_at < now() + interval '2 minutes'",
      );
      const release = await (i % 2 ? a : b).turn('192.0.2.81', 'daily-visitor', new AbortController());
      await release();
    }
    await assert.rejects(b.turn('192.0.2.82', 'daily-visitor', new AbortController()), /guide-rate-limit/);
    await first.query('DELETE FROM app.api_rate_limits');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: url.href,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: 'http://localhost:3001',
      WEB_ORIGIN: 'http://localhost:5173',
      TURNSTILE_SITE_KEY: 'fixture-site',
      TURNSTILE_SECRET_KEY: 'fixture-secret',
      GOOGLE_CLIENT_ID: 'fixture-google-id',
      GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    });
    const links = [];
    const used = new Set();
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const token = init.body.get('response');
      const valid = !used.has(token) && ['session', 'email', 'google'].includes(token);
      used.add(token);
      return Response.json({
        success: valid,
        hostname: 'localhost',
        action: token === 'session' ? 'public_guide' : 'sign_in',
      });
    });
    const auth = createAuth(first, async ({ url }) => links.push(url));
    app = Fastify();
    registerSecurity(app, process.env.WEB_ORIGIN);
    app.register(async routes => registerPublicGuide(routes, { auth, pool: first }), { prefix: '/v1' });
    const origin = 'http://localhost:5100';
    const post = (path, payload, token) =>
      app.inject({
        method: 'POST',
        url: `/v1/public/guide/${path}`,
        headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        payload,
      });
    const session = await post('session', { challengeToken: 'session' });
    assert.equal(session.statusCode, 200, session.body);
    const visitor = session.json().token;
    assert.equal(
      (await post('session', { challengeToken: 'session' })).statusCode,
      403,
      'A challenge cannot mint a second browser token',
    );
    const draftToken = randomBytes(32).toString('hex');
    const details = {
      accountType: 'business',
      name: 'Guide workspace',
      slug: 'guide-workspace',
      messages: [
        { role: 'user', content: 'Help me onboard my studio.' },
        { role: 'assistant', content: 'Choose your workspace name and URL.' },
      ],
    };
    const signup = await post(
      'signup',
      {
        method: 'email',
        token: draftToken,
        details,
        challengeToken: 'email',
        name: 'Guide user',
        email: 'guide@example.com',
      },
      visitor,
    );
    assert.equal(signup.statusCode, 200, signup.body);
    assert.deepEqual(signup.json(), { status: 'email-sent' });
    assert.equal(links.length, 1);
    assert.equal((await first.query('SELECT count(*) FROM app.users')).rows[0].count, '0');
    assert.equal((await first.query('SELECT count(*) FROM app.workspaces')).rows[0].count, '0');
    const verified = await auth.handler(new Request(links[0]));
    assert.equal(verified.status, 302);
    assert.equal(verified.headers.get('location'), `http://localhost:5173/onboarding/chat#token=${draftToken}`);
    const userId = (await first.query('SELECT id FROM app.users')).rows[0].id;
    const resumed = await resumeOnboarding(first, draftToken, userId);
    assert.deepEqual(resumed.details, details);
    const googleDraft = randomBytes(32).toString('hex');
    const google = await post(
      'signup',
      { method: 'google', token: googleDraft, details, challengeToken: 'google' },
      visitor,
    );
    assert.equal(google.statusCode, 200, google.body);
    const continuation = new URL(google.json().url);
    const redirect = await app.inject(continuation.pathname + continuation.search);
    assert.equal(redirect.statusCode, 302, redirect.body);
    assert.equal(new URL(redirect.headers.location).hostname, 'accounts.google.com');
    assert.ok(redirect.headers['set-cookie'], 'Top-level navigation sets OAuth state cookies before leaving the API');
    assert.equal(
      (await first.query('SELECT count(*) FROM app.workspaces')).rows[0].count,
      '0',
      'Only authenticated completion creates workspaces',
    );
  },
);
