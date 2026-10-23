import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { githubFixture } from '../../../packages/github/test/fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerGitHubAccounts } from '../src/github-accounts.ts';
import { githubAccounts } from '../src/github-composition.ts';

test('GitHub HTTP composition authorizes owners, validates requests and conceals credentials', async t => {
  const f = await githubFixture();
  const logs = [];
  const app = Fastify({ logger: { level: 'trace', stream: { write: line => logs.push(line) } } });
  const origin = authConfig().webOrigin;
  const member = { cookie: 'session=member', origin };
  const admin = { cookie: 'session=admin', origin };
  const sessions = new Map([
    [member.cookie, { user: { id: f.member.userId }, session: { id: 'member-session' } }],
    [admin.cookie, { user: { id: f.one.userId }, session: { id: 'admin-session' } }],
    ['session=other', { user: { id: f.member.userId }, session: { id: 'other-session' } }],
  ]);
  const auth = { api: { getSession: async ({ headers }) => sessions.get(headers.get('cookie')) ?? null } };
  const base = `/v1/workspaces/${f.one.id}/github/accounts`;
  const callback = '/v1/github/oauth/callback';
  const request = async (options, status) => {
    const response = await app.inject({ headers: member, ...options });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    return response.json();
  };
  try {
    await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'GitHub accounts', version: '1' } } });
    await app.register(async routes => registerGitHubAccounts(routes, auth, f.service), { prefix: '/v1' });
    await app.ready();
    await t.test(
      'composition disables absent configuration and rejects partial or unusable configuration',
      async () => {
        assert.equal(githubAccounts(undefined, {}), null);
        assert.equal((await githubAccounts(f.runtime, {}).list(f.one.id, f.member.userId)).configured, false);
        assert.throws(() => githubAccounts(f.runtime, { GITHUB_OAUTH_CLIENT_ID: 'partial' }), /Invalid GitHub/);
        const env = {
          WEB_ORIGIN: new URL(f.configuration.redirectUri).origin,
          GITHUB_OAUTH_CLIENT_ID: f.configuration.clientId,
          GITHUB_OAUTH_CLIENT_SECRET: f.configuration.clientSecret,
          GITHUB_OAUTH_REDIRECT_URI: f.configuration.redirectUri,
        };
        assert.throws(() => githubAccounts(f.runtime, env));
        env.INTEGRATION_CREDENTIAL_KEY_ID = 'test';
        env.INTEGRATION_CREDENTIAL_KEY = 'ab'.repeat(32);
        assert.throws(() => githubAccounts(undefined, env), /requires workspace/);
        assert.equal((await githubAccounts(f.runtime, env).list(f.one.id, f.member.userId)).configured, true);
        assert.throws(() => githubAccounts(f.runtime, { ...env, WEB_ORIGIN: 'https://other.test' }), /WEB_ORIGIN/);
      },
    );
    await t.test('authentication and same-origin checks precede persistence and provider calls', async () => {
      const item = `${base}/${randomUUID()}`;
      for (const route of [
        { url: base },
        { url: item },
        { method: 'POST', url: `${base}/begin`, payload: {} },
        { method: 'POST', url: `${item}/reconnect` },
        { method: 'POST', url: `${item}/disconnect` },
        { method: 'POST', url: callback, payload: {} },
      ])
        await request({ ...route, headers: { origin } }, 401);
      for (const headers of [{ cookie: member.cookie }, { cookie: member.cookie, origin: 'https://attacker.test' }])
        await request({ method: 'POST', url: `${base}/begin`, payload: {}, headers }, 403);
      assert.equal(f.calls.length, 0);
      await request({ method: 'POST', url: `${base}/begin`, payload: { ownership: 'business' } }, 400);
    });
    let started;
    await t.test('callback validates once-only session-bound consent and returns metadata only', async () => {
      started = await request({ method: 'POST', url: `${base}/begin`, payload: {} }, 200);
      const payload = { code: 'private-callback-code', state: new URL(started.url).searchParams.get('state') };
      await request({ method: 'POST', url: callback, payload, headers: { origin, cookie: 'session=other' } }, 404);
      await request({ method: 'POST', url: callback, payload, headers: admin }, 404);
      for (const invalid of [
        { ...payload, credential: 'bad' },
        { ...payload, error: 'access_denied' },
        { ...payload, state: [payload.state] },
      ])
        await request({ method: 'POST', url: callback, payload: invalid }, 400);
      const result = await request({ method: 'POST', url: callback, payload }, 200);
      assert.deepEqual(result.account.identity, { id: '123', login: 'octocat' });
      assert.equal(result.account.state, 'active');
      await request({ method: 'POST', url: callback, payload }, 404);
      const list = await request({ url: base }, 200);
      assert.deepEqual(list.accounts, [result.account]);
      for (const secret of [
        payload.code,
        payload.state,
        'synthetic-access-token',
        'fixture-secret',
        'credential',
        'verifier',
        'config_hash',
      ])
        assert.equal(JSON.stringify(result).includes(secret), false);
    });
    await t.test('admin has no personal account override, owner can disconnect and reconnect', async () => {
      assert.deepEqual((await request({ url: base, headers: admin }, 200)).accounts, []);
      const item = `${base}/${started.accountId}`;
      for (const route of [
        { url: item },
        { method: 'POST', url: `${item}/disconnect` },
        { method: 'POST', url: `${item}/reconnect` },
      ])
        await request({ ...route, headers: admin }, 404);
      const disconnected = await request({ method: 'POST', url: `${item}/disconnect` }, 200);
      assert.equal(disconnected.account.state, 'disconnected');
      assert.equal(disconnected.providerRevocation, 'manual-required');
      const again = await request({ method: 'POST', url: `${item}/disconnect` }, 200);
      assert.equal(again.account.generation, disconnected.account.generation);
      const next = await request({ method: 'POST', url: `${item}/reconnect` }, 200);
      await request(
        {
          method: 'POST',
          url: callback,
          payload: {
            state: new URL(next.url).searchParams.get('state'),
            error: 'access_denied',
            error_description: 'private-diagnostic',
          },
        },
        400,
      );
      assert.equal((await request({ url: item }, 200)).state, 'reconnect-required');
    });
    await t.test('OpenAPI success schemas are closed and trace logs omit authorization material', async () => {
      const paths = app.swagger().paths;
      assert.ok(paths[callback].post);
      const shape =
        paths['/v1/workspaces/{workspaceId}/github/accounts/{accountId}'].get.responses['200'].content[
          'application/json'
        ].schema;
      assert.equal(shape.additionalProperties, false);
      assert.equal(shape.properties.credential, undefined);
      app.log.info('github-log-probe');
      assert.ok(logs.join('').includes('github-log-probe'));
      for (const secret of [
        'private-callback-code',
        'private-diagnostic',
        'synthetic-access-token',
        new URL(started.url).searchParams.get('state'),
      ])
        assert.equal(logs.join('').includes(secret), false);
    });
  } finally {
    await app.close();
    await f.close();
  }
});
