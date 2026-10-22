import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool, escapeIdentifier } from 'pg';
import { readMigrations } from '../../database/src/migrations.ts';
import { createAuth } from '../src/auth.ts';
import { protectBusinessRequests } from '../src/business.ts';
import { createAbuseLimiter, registerAbuseHooks } from '../src/abuse.ts';
import { registerWorkspaces } from '../src/workspaces.ts';
import { expireOnboarding } from '@tulipfarm/workspaces/onboarding';

test(
  'onboarding drafts survive authentication and restart, bind one account, and create one workspace',
  { timeout: 60000 },
  async t => {
    const oldEnv = { ...process.env };
    const admin = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    const database = `onboarding_${randomUUID().replaceAll('-', '')}`;
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='tulipfarm') THEN CREATE ROLE tulipfarm; END IF; END $$`,
    );
    await admin.query(`CREATE DATABASE ${escapeIdentifier(database)}`);
    const url = new URL(admin.options.connectionString);
    url.pathname = `/${database}`;
    const pool = new Pool({ connectionString: url.href, options: '-c search_path=app' });
    const apps = [];
    t.after(async () => {
      await Promise.all(apps.map(app => app.close()));
      await pool.end();
      await admin.query(`DROP DATABASE ${escapeIdentifier(database)}`);
      await admin.end();
      process.env = oldEnv;
    });
    for (const migration of await readMigrations(fileURLToPath(new URL('../../database/migrations', import.meta.url))))
      await pool.query(migration.sql);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
      WORKSPACE_RUNTIME_KEY_ID: 'test',
      WORKSPACE_RUNTIME_KEY: 'ab'.repeat(32),
      TURNSTILE_SITE_KEY: 'fixture-site',
      TURNSTILE_SECRET_KEY: 'fixture-secret',
      WEB_ORIGIN: 'http://localhost:5173',
      BETTER_AUTH_URL: 'http://localhost:3001',
    });
    const links = [];
    const auth = createAuth(
      pool,
      async ({ url }) => links.push(url),
      async () => {},
    );
    const publicHeaders = { origin: process.env.WEB_ORIGIN };
    async function signIn(callbackURL, email = `${randomUUID()}@example.com`) {
      await auth.api.signInMagicLink({
        headers: new Headers(publicHeaders),
        body: { email, name: 'Onboarding user', callbackURL, newUserCallbackURL: callbackURL },
      });
      const response = await auth.handler(new Request(links.pop()));
      assert.equal(response.headers.get('location'), callbackURL);
      return {
        ...publicHeaders,
        cookie: response.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; '),
      };
    }
    const dispatches = [];
    function replica() {
      const app = Fastify();
      protectBusinessRequests(app);
      registerAbuseHooks(app, createAbuseLimiter(pool, 'onboarding-test'), auth);
      app.register(
        async routes =>
          registerWorkspaces(
            routes,
            { auth, pool },
            {
              connection: { withDeadline: async (_deadline, operation) => operation() },
              client: { workflow: { start: async (_name, options) => dispatches.push(options.workflowId) } },
            },
          ),
        { prefix: '/v1' },
      );
      apps.push(app);
      return app;
    }
    const token = randomBytes(32).toString('hex');
    const details = {
      accountType: 'business',
      name: 'Sample business',
      slug: 'sample-business',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'What is your workspace name?' },
      ],
    };
    const body = { token, details };
    const post = (app, path, payload, headers = publicHeaders) =>
      app.inject({ method: 'POST', url: `/v1/onboarding/${path}`, headers, payload });
    const first = replica();
    assert.equal((await post(first, 'drafts', body, { origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await post(first, 'drafts', { ...body, token: 'guessable' })).statusCode, 400);
    assert.equal((await post(first, 'drafts', { ...body, details: { ...details, slug: 'login' } })).statusCode, 400);
    assert.equal(
      (
        await post(first, 'drafts', {
          ...body,
          details: { ...details, messages: [{ role: 'system', content: 'Untrusted' }] },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(first, 'drafts', {
          ...body,
          details: {
            ...details,
            messages: Array.from({ length: 20 }, () => ({ role: 'user', content: 'a'.repeat(2000) })),
          },
        })
      ).statusCode,
      413,
    );
    const saved = await post(first, 'drafts', body);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().details, details);
    assert.ok(Date.parse(saved.json().expiresAt) > Date.now());
    assert.equal(saved.headers['cache-control'], 'no-store');
    assert.equal(saved.body.includes(token), false);
    assert.equal(
      (await pool.query('SELECT token_hash FROM app.onboarding_drafts')).rows[0].token_hash,
      createHash('sha256').update(token).digest('hex'),
    );
    assert.equal((await post(first, 'drafts', body)).json().id, saved.json().id);
    assert.equal((await post(first, 'drafts', { ...body, details: { ...details, name: 'Changed' } })).statusCode, 409);
    assert.equal((await post(first, 'resume', { token })).statusCode, 401);
    assert.equal((await post(first, 'complete', { token })).statusCode, 401);
    assert.equal((await pool.query('SELECT * FROM app.workspaces')).rowCount, 0);

    const callback = `${process.env.WEB_ORIGIN}/onboarding#token=${token}`;
    const email = `${randomUUID()}@example.com`;
    const headers = await signIn(callback, email);
    await first.close();
    const second = replica();
    assert.deepEqual((await post(second, 'resume', { token }, headers)).json(), saved.json());
    const sameUser = await signIn(callback, email);
    assert.equal(
      (await post(second, 'resume', { token }, sameUser)).statusCode,
      200,
      'Another browser signed in as the same person resumes',
    );
    const other = await signIn(callback);
    assert.equal((await post(second, 'resume', { token }, other)).statusCode, 404);
    assert.equal((await post(second, 'complete', { token }, other)).statusCode, 404);
    assert.equal(
      (await post(second, 'drafts', body)).statusCode,
      404,
      'Anonymous writes cannot replay a claimed draft',
    );

    let verified = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      verified++;
      return Response.json({
        success: options.body.get('response') === 'valid',
        hostname: 'localhost',
        action: 'create_workspace',
      });
    });
    assert.equal((await post(second, 'complete', { token }, headers)).statusCode, 403);
    await pool.query('DELETE FROM app.api_rate_limits');
    const concurrent = await Promise.all([
      post(second, 'complete', { token, challengeToken: 'valid' }, headers),
      post(second, 'complete', { token, challengeToken: 'valid' }, headers),
    ]);
    for (const response of concurrent) assert.equal(response.statusCode, 202, response.body);
    assert.equal(concurrent[0].json().id, concurrent[1].json().id);
    assert.equal(verified, 1, 'Durable replay skips the single-use challenge');
    const retry = await post(second, 'complete', { token }, headers);
    assert.equal(retry.statusCode, 202, retry.body);
    assert.equal(retry.json().id, concurrent[0].json().id);
    assert.equal((await pool.query('SELECT * FROM app.workspaces')).rowCount, 1);
    assert.ok(dispatches.length > 0);
    assert.equal((await post(second, 'complete', { token }, headers)).statusCode, 429);
    await pool.query('DELETE FROM app.api_rate_limits');
    const collisionToken = randomBytes(32).toString('hex');
    await post(second, 'drafts', { token: collisionToken, details });
    assert.equal(
      (await post(second, 'complete', { token: collisionToken, challengeToken: 'valid' }, headers)).statusCode,
      409,
    );
    await pool.query("UPDATE app.onboarding_drafts SET expires_at = now() - interval '1 second'");
    assert.equal((await post(second, 'resume', { token }, headers)).statusCode, 404);
    await expireOnboarding(pool);
    assert.equal((await pool.query('SELECT * FROM app.onboarding_drafts')).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM app.workspaces')).rowCount, 1, 'Expiry never deletes the workspace');

    await pool.query('DELETE FROM app.api_rate_limits');
    for (let i = 0; i < 20; i++)
      assert.equal((await post(second, 'drafts', { token: randomBytes(32).toString('hex'), details })).statusCode, 200);
    assert.equal((await post(second, 'drafts', { token: randomBytes(32).toString('hex'), details })).statusCode, 429);
    await pool.query('GRANT USAGE ON SCHEMA app TO tulipfarm; SET ROLE tulipfarm');
    assert.equal((await pool.query('SELECT count(*) FROM app.onboarding_drafts')).rows[0].count, '20');
    await pool.query('DELETE FROM app.onboarding_drafts; RESET ROLE');
  },
);
