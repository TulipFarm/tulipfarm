import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool, escapeIdentifier } from 'pg';
import { readMigrations } from '../../database/src/migrations.ts';
import { createAuth } from '../src/auth.ts';
import { createAbuseLimiter, registerAbuseHooks } from '../src/abuse.ts';
import { protectBusinessRequests } from '../src/business.ts';
import { registerWorkspaces } from '../src/workspaces.ts';

test(
  'workspace CAPTCHA rejects unverified creation and permits only durable same-request retries',
  { timeout: 60000 },
  async t => {
    const oldEnv = { ...process.env };
    const admin = new Pool({
      connectionString:
        process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres',
    });
    const name = `captcha_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    const url = new URL(admin.options.connectionString);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.href, options: '-c search_path=app' });
    const apps = [];
    t.after(async () => {
      await Promise.all(apps.map(app => app.close()));
      await pool.end();
      await admin.query(`DROP DATABASE ${escapeIdentifier(name)}`);
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
    async function signIn() {
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: process.env.WEB_ORIGIN }),
        body: { email: `${randomUUID()}@example.com`, name: 'CAPTCHA user' },
      });
      const response = await auth.handler(new Request(links.pop()));
      return {
        origin: process.env.WEB_ORIGIN,
        cookie: response.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; '),
      };
    }
    const headers = await signIn(),
      otherHeaders = await signIn();
    const consumed = new Set();
    let verifications = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      const token = options.body.get('response');
      verifications++;
      if (token === 'unavailable') throw new Error('Provider unavailable');
      if (!token.startsWith('valid-') || consumed.has(token))
        return Response.json({
          success: false,
          'error-codes': [token === 'invalid' ? 'invalid-input-response' : 'timeout-or-duplicate'],
        });
      consumed.add(token);
      await new Promise(resolve => setTimeout(resolve, 30));
      return Response.json({ success: true, hostname: 'localhost', action: 'create_workspace' });
    });
    const dispatches = [];
    function replica() {
      const app = Fastify();
      protectBusinessRequests(app);
      registerAbuseHooks(app, createAbuseLimiter(pool, 'captcha-test-limiter'), auth);
      app.register(
        async routes => {
          registerWorkspaces(
            routes,
            { auth, pool },
            {
              connection: { withDeadline: async (_deadline, operation) => operation() },
              client: { workflow: { start: async (_name, options) => dispatches.push(options.workflowId) } },
            },
          );
        },
        { prefix: '/v1' },
      );
      apps.push(app);
      return app;
    }
    const first = replica(),
      second = replica();
    const input = { requestId: randomUUID(), name: 'CAPTCHA workspace', slug: 'captcha-workspace' };
    const post = (app, payload, requestHeaders = headers) =>
      app.inject({ method: 'POST', url: '/v1/workspaces', headers: requestHeaders, payload });
    const resetLimits = () => pool.query('DELETE FROM app.api_rate_limits');
    const count = async () => (await pool.query('SELECT count(*)::integer AS count FROM app.workspaces')).rows[0].count;
    assert.equal((await post(first, input, { origin: headers.origin })).statusCode, 401);
    assert.equal((await post(first, input, { ...headers, origin: 'https://untrusted.example' })).statusCode, 403);
    assert.equal(verifications, 0);
    for (const token of [undefined, '', 'invalid', 'expired', 'unavailable']) {
      await resetLimits();
      const response = await post(first, { ...input, ...(token === undefined ? {} : { challengeToken: token }) });
      assert.equal(response.statusCode, 403, response.body);
      assert.match(response.json().error, /complete a new challenge/);
      assert.equal(await count(), 0);
      assert.equal(dispatches.length, 0);
    }
    await resetLimits();
    const before = verifications;
    const payload = { ...input, challengeToken: 'valid-first' };
    const results = await Promise.all([post(first, payload), post(second, payload)]);
    for (const response of results) assert.equal(response.statusCode, 202, response.body);
    assert.equal(results[0].json().id, results[1].json().id);
    assert.equal(verifications, before + 1, 'Concurrent retries verify once under the database lock');
    assert.equal(await count(), 1);
    assert.equal((await pool.query('SELECT * FROM app.workspace_storage')).rowCount, 1);

    await first.close();
    const restarted = replica();
    const retry = await post(restarted, input);
    assert.equal(retry.statusCode, 202, retry.body);
    assert.equal(
      retry.json().id,
      results[0].json().id,
      'Lost-response retry survives API restart without re-verifying a consumed token',
    );
    assert.equal(verifications, before + 1);
    const limited = await post(second, payload);
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(verifications, before + 1, 'Rate limits run before verification, including safe retries');

    for (const request of [
      { payload: { ...payload, requestId: randomUUID(), slug: 'replayed-token' }, headers },
      { payload: { ...payload, slug: 'another-user' }, headers: otherHeaders },
    ]) {
      await resetLimits();
      assert.equal((await post(second, request.payload, request.headers)).statusCode, 403);
      assert.equal(await count(), 1);
    }
    await resetLimits();
    assert.equal((await post(second, { ...input, name: 'Changed name' })).statusCode, 409);
    assert.equal((await post(second, { ...input, slug: 'changed-slug' })).statusCode, 409);
    assert.equal(await count(), 1);

    await resetLimits();
    await pool.query(`CREATE FUNCTION app.reject_captcha_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
    CREATE TRIGGER reject_captcha_insert BEFORE INSERT ON app.workspace_storage FOR EACH ROW EXECUTE FUNCTION app.reject_captcha_insert()`);
    const failedInput = {
      requestId: randomUUID(),
      name: 'Retry after rollback',
      slug: 'retry-rollback',
      challengeToken: 'valid-rollback',
    };
    assert.equal((await post(second, failedInput)).statusCode, 500);
    assert.equal(await count(), 1, 'Failure after Siteverify rolls back workspace insertion');
    await pool.query('DROP TRIGGER reject_captcha_insert ON app.workspace_storage');
    assert.equal(
      (await post(second, failedInput)).statusCode,
      403,
      'A rolled-back request still needs a fresh single-use token',
    );
    const recovered = await post(second, { ...failedInput, challengeToken: 'valid-recovery' });
    assert.equal(recovered.statusCode, 202, recovered.body);
    assert.equal(await count(), 2);
    await resetLimits();
    await pool.query(
      "UPDATE app.workspace_storage SET stage = 'unavailable', disabled_at = now(), disabled_operation_id = $2 WHERE workspace_id = $1",
      [results[0].json().id, randomUUID()],
    );
    assert.equal((await post(second, payload)).statusCode, 404, 'Retries cannot resurrect disabled workspaces');
  },
);
