import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { createSocialAccounts } from '@tulipfarm/social/accounts';
import { createPlatformApps, operatorPlatformApps } from '@tulipfarm/social/platform-apps';
import { createFakeAdapter } from '@tulipfarm/social/testing/fake';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerSocialAccounts } from '../src/social-accounts.ts';
import { socialAccounts } from '../src/social-composition.ts';

const callbackUrl = 'https://api.example.test/v1/social/oauth/callback';
const keyring = { activeKeyId: 'test', keys: { test: 'cd'.repeat(32) } };
const operator = operatorPlatformApps({
  SOCIAL_LINKEDIN_CLIENT_ID: 'operator-linkedin',
  SOCIAL_LINKEDIN_CLIENT_SECRET: 'operator-linkedin-secret',
  SOCIAL_LINKEDIN_REDIRECT_URI: callbackUrl,
  SOCIAL_LINKEDIN_ACCESS_TIER: 'share',
  SOCIAL_X_CLIENT_ID: 'operator-x',
  SOCIAL_X_CLIENT_SECRET: 'operator-x-secret',
  SOCIAL_X_REDIRECT_URI: callbackUrl,
  SOCIAL_X_ACCESS_TIER: 'paid',
});
const hosted = {
  resolve: async platform => ({
    kind: 'app',
    app: { clientId: `hosted-${platform}`, clientSecret: 'hosted-secret', accessTier: 'share', generation: 1 },
  }),
};
const fake = platform =>
  createFakeAdapter({ platform, refreshPolicy: 'refresh-token', scopes: () => ['fake.publish'] })
    .fallback('exchangeCode', {
      accessToken: `${platform}-access-token-value`,
      refreshToken: `${platform}-refresh-token-value`,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['fake.publish'],
    })
    .fallback('identity', { platformUserId: `${platform}-person`, handle: 'person', displayName: 'Person' })
    .fallback('revoke', 'revoked');

let db;
let runtime;
before(async () => {
  db = await fixture();
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    maxPools: 2,
    connectionsPerPool: 4,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => {
      const workspace = db.workspaces.find(candidate => candidate.id === id);
      if (!workspace) throw new Error('unknown-workspace');
      return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
    },
  });
});
after(async () => {
  await runtime?.close();
  await db?.close();
});

async function harness({ platformApps, flagged = () => true } = {}) {
  const ws = await db.create();
  const origin = authConfig().webOrigin;
  const admin = { cookie: 'session=admin', origin };
  const sessions = new Map([
    [admin.cookie, { user: { id: ws.userId }, session: { id: 'admin-session' } }],
    ['session=outsider', { user: { id: randomUUID() }, session: { id: 'outsider-session' } }],
  ]);
  const auth = { api: { getSession: async ({ headers }) => sessions.get(headers.get('cookie')) ?? null } };
  const accounts = createSocialAccounts({
    runtime,
    keyring,
    platformApps: platformApps ?? createPlatformApps({ operator, callbackUrl }),
    adapters: { linkedin: fake('linkedin'), x: fake('x'), reddit: fake('reddit') },
  });
  const app = Fastify();
  await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'Social', version: '1' } } });
  await app.register(
    async routes => registerSocialAccounts(routes, auth, accounts, async (_user, workspace) => flagged(workspace)),
    { prefix: '/v1' },
  );
  await app.ready();
  const base = `/v1/workspaces/${ws.id}/social`;
  const request = async (options, status, expected) => {
    const response = await app.inject({ headers: admin, ...options });
    assert.equal(response.statusCode, status, `${options.method ?? 'GET'} ${options.url}: ${response.body}`);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    const value = response.body ? response.json() : undefined;
    if (expected !== undefined) assert.deepEqual(value, expected);
    return value;
  };
  return { ws, app, base, admin, origin, request };
}

test('PRODUCT 1-8 routes require the social-publishing flag, a session and the trusted origin', async () => {
  const { app, base, admin, origin, request } = await harness({ flagged: () => false });
  try {
    const item = `${base}/accounts/${randomUUID()}`;
    const reads = [
      `${base}/availability`,
      `${base}/platform-apps`,
      `${base}/accounts`,
      item,
      `/v1/social/oauth/callback?state=${randomUUID()}.${'a'.repeat(43)}&code=x`,
    ];
    const writes = [
      { url: `${base}/platform-apps`, payload: {} },
      { url: `${base}/platform-apps/${randomUUID()}/replace-secret`, payload: { clientSecret: 'x' } },
      { url: `${base}/accounts/begin`, payload: { platform: 'linkedin', ownership: { kind: 'personal' } } },
      { url: `${item}/reconnect` },
      { url: `${item}/disconnect` },
    ];
    // Server-enforced: the flag hides every route, including the OAuth callback.
    for (const url of reads) await request({ url }, 404, { error: 'not-found' });
    for (const route of writes) await request({ method: 'POST', ...route }, 404, { error: 'not-found' });
    for (const route of writes) {
      await request({ method: 'POST', ...route, headers: { cookie: admin.cookie } }, 403, {
        error: 'untrusted-origin',
      });
      await request({ method: 'POST', ...route, headers: { origin } }, 401, { error: 'sign-in-required' });
    }
    for (const url of reads) await request({ url, headers: {} }, 401, { error: 'sign-in-required' });
  } finally {
    await app.close();
  }
});

test('PRODUCT 1-8 routes fail closed without a configured service', async () => {
  assert.equal(socialAccounts(undefined, {}), null);
  // No INTEGRATION_CREDENTIAL keyring: no credentials can be sealed, so no service.
  assert.equal(socialAccounts(runtime, {}), null);
  const ws = await db.create();
  const app = Fastify();
  const auth = { api: { getSession: async () => ({ user: { id: ws.userId }, session: { id: 's' } }) } };
  registerSocialAccounts(app, auth, null, async () => true);
  try {
    const response = await app.inject({ url: `/workspaces/${ws.id}/social/accounts` });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'account-unavailable' });
  } finally {
    await app.close();
  }
});

test('PRODUCT 4 exit check: hosted X needs a workspace app over HTTP even when operator settings exist', async () => {
  const { app, base, request } = await harness({
    platformApps: createPlatformApps({ hosted, operator, callbackUrl }),
  });
  try {
    const begin = { platform: 'x', ownership: { kind: 'personal' } };
    await request({ method: 'POST', url: `${base}/accounts/begin`, payload: begin }, 409, {
      error: 'workspace-app-required',
    });
    const availability = await request({ url: `${base}/availability` }, 200);
    const x = availability.find(item => item.platform === 'x');
    assert.deepEqual([x.available, x.reason], [false, 'workspace-app-required']);
    const created = await request(
      {
        method: 'POST',
        url: `${base}/platform-apps`,
        payload: {
          platform: 'x',
          name: 'Our X app',
          clientId: 'own-x',
          clientSecret: 'own-x-secret',
          accessTier: 'paid',
        },
      },
      200,
    );
    assert.equal(JSON.stringify(created).includes('own-x-secret'), false);
    const listed = await request({ url: `${base}/platform-apps` }, 200);
    assert.equal(JSON.stringify(listed).includes('own-x-secret'), false);
    const started = await request(
      { method: 'POST', url: `${base}/accounts/begin`, payload: { ...begin, platformAppId: created.id } },
      200,
    );
    assert.equal(new URL(started.authorizationUrl).searchParams.get('client_id'), 'own-x');
  } finally {
    await app.close();
  }
});

test('PRODUCT 7 and 8: begin, callback, reconnect and disconnect over HTTP', async () => {
  const { ws, app, base, request } = await harness();
  try {
    const begin = { platform: 'linkedin', ownership: { kind: 'personal' } };
    const started = await request({ method: 'POST', url: `${base}/accounts/begin`, payload: begin }, 200);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    assert.ok(state.startsWith(ws.id));
    // A different session cannot complete the attempt.
    await request(
      { url: `/v1/social/oauth/callback?code=c&state=${state}`, headers: { cookie: 'session=outsider' } },
      404,
      { error: 'account-not-found' },
    );
    const browser = await app.inject({
      url: `/v1/social/oauth/callback?code=platform-code&state=${state}`,
      headers: { cookie: 'session=admin', accept: 'text/html' },
    });
    assert.equal(browser.statusCode, 302);
    const location = new URL(browser.headers.location);
    assert.equal(location.origin, authConfig().webOrigin);
    assert.equal(location.pathname, '/social/callback');
    assert.equal(location.searchParams.get('outcome'), 'connected');
    assert.equal(location.searchParams.get('platform'), 'linkedin');
    assert.equal(browser.body.includes('access-token'), false);
    // The state is single use, and a replay reveals nothing about the attempt.
    await request({ url: `/v1/social/oauth/callback?code=platform-code&state=${state}` }, 404, {
      error: 'account-not-found',
    });

    const account = await request({ url: `${base}/accounts/${started.attemptId}` }, 200);
    assert.equal(account.state, 'active');
    assert.equal(JSON.stringify(account).includes('token-value'), false);

    const again = await request({ method: 'POST', url: `${base}/accounts/${started.attemptId}/reconnect` }, 200);
    const reconnectState = new URL(again.authorizationUrl).searchParams.get('state');
    const completed = await request({ url: `/v1/social/oauth/callback?code=code-2&state=${reconnectState}` }, 200);
    assert.equal(completed.account.generation, account.generation + 1);

    const declined = await request({ method: 'POST', url: `${base}/accounts/begin`, payload: begin }, 200);
    const declinedState = new URL(declined.authorizationUrl).searchParams.get('state');
    const denied = await app.inject({
      url: `/v1/social/oauth/callback?error=access_denied&state=${declinedState}`,
      headers: { cookie: 'session=admin', accept: 'text/html' },
    });
    assert.equal(new URL(denied.headers.location).searchParams.get('outcome'), 'denied');

    await request({ method: 'POST', url: `${base}/accounts/${started.attemptId}/disconnect` }, 200);
    assert.equal((await request({ url: `${base}/accounts/${started.attemptId}` }, 200)).state, 'disconnected');
    await request({ url: `${base}/accounts`, headers: { cookie: 'session=outsider' } }, 404, {
      error: 'account-not-found',
    });
  } finally {
    await app.close();
  }
});
