import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { config, googleFixture } from '../../../packages/google-workspace/test/fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerGoogleWorkspace } from '../src/google-workspace.ts';

test('personal Google OAuth over HTTP with restricted workspace PostgreSQL', { timeout: 60000 }, async t => {
  const f = await googleFixture();
  const logs = [];
  const app = Fastify({ logger: { level: 'trace', stream: { write: line => logs.push(line) } } });
  const origin = authConfig().webOrigin;
  const member = { cookie: 'session=member', origin };
  const admin = { cookie: 'session=admin', origin };
  const otherSession = { cookie: 'session=other-member-session', origin };
  const outsider = { cookie: 'session=outsider', origin };
  const sessions = new Map([
    [member.cookie, { user: { id: f.principal.userId }, session: { id: f.principal.sessionId } }],
    [otherSession.cookie, { user: { id: f.principal.userId }, session: { id: randomUUID() } }],
    [admin.cookie, { user: { id: f.admin.userId }, session: { id: randomUUID() } }],
    [outsider.cookie, { user: { id: randomUUID() }, session: { id: randomUUID() } }],
  ]);
  const auth = {
    api: {
      getSession: async ({ headers }) => {
        if (headers.get('cookie') === 'session=broken') throw new Error('private-session-diagnostic');
        return sessions.get(headers.get('cookie')) ?? null;
      },
    },
  };
  const base = `/v1/workspaces/${f.workspace.id}/google-workspace`;
  const callback = '/v1/google-workspace/callback';
  const disconnected = { status: 'disconnected' };
  const denied = { error: 'integration-not-found' };
  const expectedScopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email',
    'openid',
  ];
  const secrets = new Set([
    config.clientSecret,
    'private-http-code',
    'initial-private-access',
    'private-refresh',
    'private provider network failure',
    'private-consent-diagnostic',
    'private-session-diagnostic',
    f.principal.sessionId,
    member.cookie,
    admin.cookie,
    otherSession.cookie,
    outsider.cookie,
  ]);
  let address;
  async function request({ path = base, method = 'GET', headers = member, body }, status, expected) {
    const response = await fetch(`${address}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    for (const secret of secrets) assert.equal(text.includes(secret), false, 'HTTP response discloses a secret');
    const result = JSON.parse(text);
    if (expected !== undefined) assert.deepEqual(result, expected);
    return result;
  }
  async function callbackRequest({ path, headers = member }, outcome, workspaceId) {
    const response = await fetch(`${address}${path}`, { headers, redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const location = response.headers.get('location');
    const url = new URL(location);
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/google-workspace/callback');
    assert.deepEqual(Object.fromEntries(url.searchParams), { outcome, ...(workspaceId ? { workspaceId } : {}) });
    const text = await response.text();
    for (const secret of [...secrets, 'member@example.com', 'google-account-1', 'https://evil.test']) {
      assert.equal(`${location}${text}`.includes(secret), false, 'callback redirect discloses private input');
    }
  }
  async function begin(headers = member) {
    const result = await request({ path: `${base}/begin`, method: 'POST', headers }, 200);
    assert.deepEqual(Object.keys(result), ['authorizationUrl']);
    const url = new URL(result.authorizationUrl);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.pathname, '/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), config.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent select_account');
    assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), expectedScopes);
    assert.match(url.searchParams.get('code_challenge'), /^[\w-]{43}$/);
    assert.match(url.searchParams.get('state'), new RegExp(`^${f.workspace.id}\\.[\\w-]{43}$`));
    f.challenge(url.searchParams.get('code_challenge'));
    const state = url.searchParams.get('state');
    secrets.add(state);
    return state;
  }
  function complete(state, code = 'private-http-code', headers = member) {
    return { path: `${callback}?${new URLSearchParams({ state, code })}`, headers };
  }
  async function storedIntegrations() {
    return (await f.db.platform.query(`SELECT * FROM ${f.table('tf_google_integrations')} ORDER BY user_id`)).rows;
  }

  try {
    await app.register(
      async routes =>
        registerGoogleWorkspace(routes, { auth, service: createGoogleWorkspaceService(f.serviceOptions) }),
      { prefix: '/v1' },
    );
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    app.log.info('google-http-log-capture-active');

    await t.test('all routes require authentication and mutations require the exact trusted origin', async () => {
      const mutations = [{ path: `${base}/begin`, method: 'POST' }, { method: 'DELETE' }];
      for (const route of mutations) {
        for (const headers of [
          { cookie: member.cookie },
          { cookie: member.cookie, origin: 'https://untrusted.example' },
        ]) {
          await request({ ...route, headers }, 403, { error: 'untrusted-origin' });
        }
      }
      for (const route of [{}, ...mutations, { path: '/v1/google-workspace/availability' }]) {
        for (const headers of [{ origin }, { origin, cookie: 'session=expired' }]) {
          await request({ ...route, headers }, 401, { error: 'sign-in-required' });
        }
      }
      for (const route of [{}, ...mutations]) {
        await request({ ...route, headers: outsider }, 404, denied);
      }
      for (const headers of [{}, { cookie: 'session=expired' }]) {
        await callbackRequest({ ...complete(`${f.workspace.id}.untrusted`), headers }, 'sign-in-required');
      }
      await callbackRequest(
        complete(`${f.workspace.id}.untrusted`, 'private-http-code', outsider),
        'integration-not-found',
      );
      await request({ path: '/v1/google-workspace/availability' }, 200, { configured: true });
      await request({ headers: { cookie: member.cookie } }, 200, disconnected);
      assert.deepEqual(await storedIntegrations(), []);
      assert.equal(f.calls.length, 0);
    });

    await t.test('workspace and callback validation reject malformed input before provider access', async () => {
      for (const [method, suffix] of [
        ['GET', ''],
        ['POST', '/begin'],
        ['DELETE', ''],
      ]) {
        await request({ method, path: `/v1/workspaces/not-a-uuid/google-workspace${suffix}` }, 400, {
          error: 'invalid-request',
        });
      }
      for (const query of [
        {},
        { state: '' },
        { state: 'x' },
        { state: 'x', code: '' },
        { state: 'x', error: '' },
        { state: 'x', code: 'x', error: 'access_denied' },
        { state: 'x'.repeat(257), code: 'x' },
        { state: 'x', code: 'x'.repeat(4097) },
        { state: 'x', error: 'x'.repeat(257) },
      ]) {
        await callbackRequest({ path: `${callback}?${new URLSearchParams(query)}` }, 'invalid-request');
      }
      await callbackRequest({ path: `${callback}?state=x&code=one&code=two` }, 'invalid-request');
      await request(
        {
          path: `${base}/begin`,
          method: 'POST',
          headers: { ...member, 'content-type': 'application/json' },
          body: '{',
        },
        400,
        { error: 'invalid-request' },
      );
      await callbackRequest(complete('invalid-state'), 'invalid-state');
      await callbackRequest(
        complete(`${f.workspace.id}.untrusted`, 'private-http-code', { cookie: 'session=broken' }),
        'integration-operation-failed',
      );
      await request({ headers: { ...member, cookie: 'session=broken' } }, 500, {
        error: 'integration-operation-failed',
      });
      await request({}, 200, disconnected);
      assert.deepEqual(await storedIntegrations(), []);
      assert.equal(f.calls.length, 0);
    });

    let connected;
    await t.test('only the initiating user and session can complete once and credentials stay encrypted', async () => {
      const state = await begin();
      const pending = (await f.db.platform.query(`SELECT * FROM ${f.table('tf_google_oauth_states')}`)).rows;
      assert.equal(pending.length, 1);
      assert.equal(JSON.stringify(pending).includes(state), false);
      assert.equal(JSON.stringify(pending).includes(f.principal.sessionId), false);
      await callbackRequest(complete(state, 'private-http-code', otherSession), 'invalid-state');
      await callbackRequest(complete(state, 'private-http-code', admin), 'invalid-state');
      await callbackRequest(complete(`${state}tampered`), 'invalid-state');
      assert.equal(f.calls.length, 0);
      const success = complete(state, 'private-http-code', { cookie: member.cookie });
      success.path +=
        '&returnUrl=https%3A%2F%2Fevil.test&email=member%40example.com&error_description=private-consent-diagnostic';
      await callbackRequest(success, 'connected', f.workspace.id);
      connected = await request({}, 200);
      assert.match(connected.integrationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.deepEqual(connected, {
        status: 'connected',
        integrationId: connected.integrationId,
        generation: 2,
        accountId: 'google-account-1',
        email: 'member@example.com',
        scopes: expectedScopes,
      });
      assert.equal(f.calls.length, 2);
      assert.equal(f.calls[0].init.body.get('code'), 'private-http-code');
      assert.equal(f.calls[1].init.headers.authorization, 'Bearer initial-private-access');
      secrets.add(f.calls[0].init.body.get('code_verifier'));
      await callbackRequest(complete(state), 'invalid-state');
      assert.equal(f.calls.length, 2);
      await request({}, 200, connected);
      const rows = await storedIntegrations();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'connected');
      assert.equal(rows[0].user_id, f.member.userId);
      assert.equal(rows[0].membership_id, f.member.membershipId);
      assert.equal(typeof rows[0].credential.ciphertext, 'string');
      assert.notEqual(rows[0].credential.ciphertext, '');
      for (const secret of ['private-http-code', 'private-refresh', 'initial-private-access']) {
        assert.equal(JSON.stringify(rows).includes(secret), false);
      }
      assert.equal((await f.db.platform.query(`SELECT * FROM ${f.table('tf_google_oauth_states')}`)).rowCount, 0);
    });

    await t.test('admin status and disconnect cannot inspect or remove a member personal integration', async () => {
      await request({ headers: admin }, 200, disconnected);
      await request({ method: 'DELETE', headers: admin }, 200, { disconnected: true, revoked: true });
      await request({}, 200, connected);
      assert.equal(f.calls.length, 2);
      await request({ method: 'DELETE' }, 200, { disconnected: true, revoked: true });
      assert.equal(f.calls.at(-1).url, 'https://oauth2.googleapis.com/revoke');
      assert.equal(f.calls.at(-1).init.body.get('token'), 'private-refresh');
      await request({}, 200, disconnected);
      const row = (await storedIntegrations())[0];
      assert.deepEqual(
        {
          status: row.status,
          credential: row.credential,
          accountId: row.account_id,
          email: row.email,
          scopes: row.scopes,
        },
        {
          status: 'disconnected',
          credential: null,
          accountId: null,
          email: null,
          scopes: [],
        },
      );
      await request({ method: 'DELETE' }, 200, { disconnected: true, revoked: true });
      assert.equal(f.calls.length, 3);
    });

    await t.test('expired, superseded and denied authorization attempts cannot be replayed', async () => {
      const old = await begin();
      const current = await begin();
      await callbackRequest(complete(old), 'invalid-state');
      f.advance(600001);
      await callbackRequest(complete(current), 'invalid-state');
      const deniedState = await begin();
      await callbackRequest(
        { path: `${callback}?${new URLSearchParams({ state: deniedState, error: 'private-consent-diagnostic' })}` },
        'consent-denied',
        f.workspace.id,
      );
      await callbackRequest(complete(deniedState), 'invalid-state');
      const loggedOutState = await begin();
      const session = sessions.get(member.cookie);
      sessions.delete(member.cookie);
      await callbackRequest(complete(loggedOutState), 'sign-in-required');
      sessions.set(member.cookie, session);
      await request({ method: 'DELETE' }, 200, { disconnected: true, revoked: true });
      await callbackRequest(complete(loggedOutState), 'invalid-state');
      await request({}, 200, disconnected);
      assert.equal(f.calls.length, 3);
    });

    await t.test('an app request asks only for that app', async () => {
      const result = await request({ path: `${base}/begin?app=calendar`, method: 'POST' }, 200);
      const url = new URL(result.authorizationUrl);
      secrets.add(url.searchParams.get('state'));
      assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/userinfo.email',
        'openid',
      ]);
      assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
      await request({ path: `${base}/begin?app=unknown`, method: 'POST' }, 400);
    });

    await t.test('provider failures are redacted, consume state and never establish an integration', async () => {
      for (const [behavior, error] of [
        [{ throw: true }, 'provider-unavailable'],
        [{ noRefresh: true }, 'reconnect-required'],
        [{ scopes: ['openid'] }, 'insufficient-scope'],
      ]) {
        f.behavior(behavior);
        const state = await begin();
        const before = f.calls.length;
        await callbackRequest(complete(state), error, f.workspace.id);
        assert.equal(f.calls.length, before + 1);
        secrets.add(f.calls.at(-1).init.body.get('code_verifier'));
        await callbackRequest(complete(state), 'invalid-state');
        assert.equal(f.calls.length, before + 1);
        await request({}, 200, disconnected);
        assert.equal((await storedIntegrations())[0].credential, null);
      }
      f.behavior({});
      const state = await begin();
      await callbackRequest(complete(state), 'connected', f.workspace.id);
      const recovered = await request({}, 200);
      assert.equal(recovered.status, 'connected');
      assert.equal(recovered.email, 'member@example.com');
      await request({}, 200, recovered);
    });

    await t.test(
      'revocation failure still disconnects locally and status exposes refresh expiry without secrets',
      async () => {
        f.behavior({ revokeStatus: 503 });
        await request({ method: 'DELETE' }, 200, { disconnected: true, revoked: false });
        await request({}, 200, disconnected);
        assert.equal((await storedIntegrations())[0].credential, null);
        f.behavior({ refreshLifetime: 10 });
        const state = await begin();
        await callbackRequest(complete(state), 'connected', f.workspace.id);
        const active = await request({}, 200);
        assert.equal(active.status, 'connected');
        f.advance(10001);
        await request({}, 200, { ...active, status: 'reconnect-required', generation: active.generation + 1 });
        assert.equal((await storedIntegrations())[0].credential, null);
        await request({ method: 'DELETE' }, 200, { disconnected: true, revoked: true });
        await request({}, 200, disconnected);
      },
    );

    await t.test(
      'a validated session retains workspace context when PKCE credentials cannot be decrypted',
      async () => {
        const state = await begin();
        await f.db.platform.query(`UPDATE ${f.table('tf_google_oauth_states')} SET verifier='{}'`);
        const before = f.calls.length;
        await callbackRequest(complete(state), 'credential-unavailable', f.workspace.id);
        await callbackRequest(complete(state), 'invalid-state');
        assert.equal(f.calls.length, before);
      },
    );

    await t.test('HTTP success and failure logs never contain callback codes, tokens or session secrets', async () => {
      await app.close();
      const output = logs.join('');
      assert.equal(output.includes('google-http-log-capture-active'), true);
      for (const call of f.calls) {
        const verifier = call.init.body?.get('code_verifier');
        if (verifier) secrets.add(verifier);
      }
      for (const secret of secrets) assert.equal(output.includes(secret), false, 'HTTP logger discloses a secret');
      assert.equal(output.includes('/google-workspace/callback?'), false);
    });
  } finally {
    try {
      await app.close();
    } finally {
      await f.close();
    }
  }
});

test('unconfigured OAuth availability is authenticated and makes no storage or provider calls', async () => {
  const app = Fastify();
  const service = createGoogleWorkspaceService({
    runtime: {
      transaction() {
        assert.fail('availability must not access storage');
      },
    },
  });
  const auth = {
    api: {
      getSession: async ({ headers }) =>
        headers.get('cookie') === 'session=member' ? { user: { id: 'member' }, session: { id: 'session' } } : null,
    },
  };
  try {
    await app.register(async routes => registerGoogleWorkspace(routes, { auth, service }), { prefix: '/v1' });
    const path = '/v1/google-workspace/availability';
    const anonymous = await app.inject({ url: path });
    assert.equal(anonymous.statusCode, 401);
    const response = await app.inject({ url: path, headers: { cookie: 'session=member' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { configured: false });
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});
