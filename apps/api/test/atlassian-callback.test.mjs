import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccountError } from '@tulipfarm/atlassian/accounts';
import { registerAtlassianAccounts } from '../src/atlassian-accounts.ts';
import { authConfig } from '../src/auth.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const account = {
  id: '22222222-2222-4222-8222-222222222222',
  protocol: 'atlassian-mcp',
  ownership: 'personal',
  state: 'active',
  configured: true,
  identity: null,
  resources: [],
  scopes: [],
  generation: 1,
  grantsVersion: 1,
  capabilities: { read: true, manage: true, use: true },
};
const state = `${workspaceId}.${'a'.repeat(43)}`;
const callback = `/atlassian/oauth/callback?code=private-code&state=${state}`;

test('browser callbacks return only a sanitized outcome to the web app; API clients retain JSON', async t => {
  let calls = 0;
  let failure;
  const app = Fastify();
  registerAtlassianAccounts(
    app,
    {
      api: {
        getSession: async ({ headers }) =>
          headers.get('cookie') === 'session=valid' ? { user: { id: 'user' }, session: { id: 'session' } } : null,
      },
    },
    {
      complete: async (code, receivedState, session, user) => {
        calls++;
        assert.equal(receivedState, state);
        assert.equal(session, 'session');
        assert.equal(user, 'user');
        if (!code) throw new AccountError('account-authorization-denied');
        if (failure) throw failure;
        return { workspaceId, account };
      },
    },
  );
  t.after(() => app.close());
  const browser = { cookie: 'session=valid', accept: 'text/html,application/xhtml+xml' };
  const checkRedirect = (response, expected) => {
    assert.equal(response.statusCode, 302);
    const location = new URL(response.headers.location);
    assert.equal(location.origin, new URL(authConfig().webOrigin).origin);
    assert.equal(location.pathname, '/atlassian/callback');
    assert.deepEqual(Object.fromEntries(location.searchParams), expected);
    assert.equal(response.body, '');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    for (const value of ['private-code', state, 'private-provider-error'])
      assert.equal(response.headers.location.includes(value), false);
  };
  checkRedirect(await app.inject({ url: callback, headers: browser }), {
    outcome: 'connected',
    workspaceId,
    protocol: 'atlassian-mcp',
  });
  assert.equal(calls, 1);
  const json = await app.inject({ url: callback, headers: { cookie: 'session=valid', accept: 'application/json' } });
  assert.equal(json.statusCode, 200);
  assert.deepEqual(json.json(), { workspaceId, account });
  checkRedirect(
    await app.inject({
      url: `/atlassian/oauth/callback?error=access_denied&error_description=private-provider-error&state=${state}`,
      headers: browser,
    }),
    { outcome: 'denied' },
  );
  failure = new AccountError('account-reconnect-required');
  checkRedirect(await app.inject({ url: callback, headers: browser }), { outcome: 'error' });
  failure = new Error('private-provider-error');
  checkRedirect(await app.inject({ url: callback, headers: browser }), { outcome: 'error' });
  const before = calls;
  checkRedirect(await app.inject({ url: `${callback}&code=duplicate`, headers: browser }), { outcome: 'error' });
  checkRedirect(await app.inject({ url: callback, headers: { accept: 'text/html' } }), { outcome: 'sign-in-required' });
  assert.equal(calls, before);
});
