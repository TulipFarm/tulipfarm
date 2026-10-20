import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerSecurity } from '../src/security.ts';
import { registerViewer } from '../src/viewer.ts';
import { authConfig } from '../src/auth.ts';

const { webOrigin, websiteOrigin } = authConfig();

function fixture(t, getSession = async () => null, lastWorkspaceFor = async () => null) {
  const app = Fastify();
  registerSecurity(app, webOrigin);
  app.register(
    async routes => {
      registerViewer(routes, { api: { getSession } }, lastWorkspaceFor);
      routes.get('/private', () => ({ private: true }));
    },
    { prefix: '/v1' },
  );
  t.after(() => app.close());
  return app;
}

test('viewer distinguishes signed-out visitors from a minimal signed-in profile', async t => {
  let session = null;
  const app = fixture(t, async ({ headers }) => {
    assert.equal(headers.get('cookie'), 'session=fixture');
    return session;
  });
  const request = () =>
    app.inject({ url: '/v1/viewer', headers: { origin: websiteOrigin, cookie: 'session=fixture' } });
  assert.deepEqual((await request()).json(), {
    authenticated: false,
    user: null,
    lastWorkspace: null,
    appUrl: `${webOrigin}/`,
  });
  session = {
    user: {
      id: 'private-id',
      name: 'Mira Patel',
      email: 'mira@example.test',
      image: null,
      canonicalEmail: 'private-email',
      lastModelFamilyId: 'private-model',
    },
    session: { id: 'private-session', token: 'private-token', ipAddress: 'private-ip' },
  };
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    authenticated: true,
    user: { name: 'Mira Patel', email: 'mira@example.test', image: null },
    lastWorkspace: null,
    appUrl: `${webOrigin}/`,
  });
  assert.ok(!response.body.includes('private-'));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
});

test('viewer returns only the last workspace summary and its app destination', async t => {
  const app = fixture(
    t,
    async () => ({ user: { id: 'viewer-id', name: 'Mira', email: 'mira@example.test' } }),
    async userId => {
      assert.equal(userId, 'viewer-id');
      return { id: 'workspace-id', name: 'Northstar', slug: 'northstar', soulCommit: 'private-commit' };
    },
  );
  const response = await app.inject({ url: '/v1/viewer', headers: { origin: websiteOrigin } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    authenticated: true,
    user: { name: 'Mira', email: 'mira@example.test', image: null },
    lastWorkspace: { id: 'workspace-id', name: 'Northstar' },
    appUrl: `${webOrigin}/northstar`,
  });
  assert.ok(!response.body.includes('private-'));
});

test('signed-out requests do not read workspace data and workspace failures remain errors', async t => {
  let authenticated = false;
  let calls = 0;
  const app = fixture(
    t,
    async () => (authenticated ? { user: { id: 'viewer-id' } } : null),
    async () => {
      calls++;
      throw new Error('workspace unavailable');
    },
  );
  assert.equal((await app.inject('/v1/viewer')).statusCode, 200);
  assert.equal(calls, 0);
  authenticated = true;
  const response = await app.inject('/v1/viewer');
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: 'internal-server-error' });
});

test('only the viewer grants the website credentialed CORS, including preflight', async t => {
  const app = fixture(t);
  for (const origin of [websiteOrigin, webOrigin]) {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const response = await app.inject({
        method,
        url: '/v1/viewer',
        headers: { origin, ...(method === 'OPTIONS' ? { 'access-control-request-method': 'GET' } : {}) },
      });
      assert.equal(response.statusCode, method === 'OPTIONS' ? 204 : 200);
      assert.equal(response.headers['access-control-allow-origin'], origin);
      assert.equal(response.headers['access-control-allow-credentials'], 'true');
      assert.match(response.headers.vary, /Origin/);
      assert.equal(response.headers['cache-control'], 'no-store');
      if (method === 'OPTIONS') assert.equal(response.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
    }
  }
  for (const url of ['/v1/private', '/v1/viewer/other']) {
    const response = await app.inject({ url, headers: { origin: websiteOrigin } });
    assert.equal(response.headers['access-control-allow-origin'], webOrigin);
  }
  const write = await app.inject({ method: 'POST', url: '/v1/viewer', headers: { origin: websiteOrigin } });
  assert.equal(write.statusCode, 404);
  assert.notEqual(write.headers['access-control-allow-origin'], websiteOrigin);
});

test('untrusted origins never read a session and lookup failures are not signed-out results', async t => {
  let calls = 0;
  const app = fixture(t, async () => {
    calls++;
    throw new Error('database unavailable');
  });
  for (const origin of ['https://evil.example', `${websiteOrigin}.evil.example`, 'null', 'https://branch.pages.dev']) {
    const response = await app.inject({ url: '/v1/viewer', headers: { origin } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(calls, 0);
  const response = await app.inject({ url: '/v1/viewer', headers: { origin: websiteOrigin } });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: 'internal-server-error' });
  assert.equal(response.headers['access-control-allow-origin'], websiteOrigin);
  assert.equal(response.headers['cache-control'], 'no-store');
});
