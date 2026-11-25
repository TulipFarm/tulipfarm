import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { browserSessionId } from '@tulipfarm/browser';
import { registerBrowserLogins } from '../src/browser-logins.ts';

const auth = {
  api: {
    getSession: async ({ headers }) =>
      headers.get('cookie') === 'session=member' ? { session: { id: 's' }, user: { id: 'member' } } : null,
  },
};
const shared = randomUUID();
const cookie = (name, domain) => ({
  name,
  value: 'v',
  domain,
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
});
const summary = input => ({
  id: randomUUID(),
  ...input,
  ownerMembershipId: randomUUID(),
  status: 'active',
  grants: [],
  canManage: true,
  canUse: true,
  createdAt: new Date().toISOString(),
  savedAt: new Date().toISOString(),
  lastUsedAt: null,
});

function setup(t, { projectId = null, loaded = [], exported }) {
  const app = Fastify();
  t.after(() => app.close());
  const workspaceId = randomUUID();
  const chatId = randomUUID();
  const sessionId = browserSessionId(workspaceId, { conversationId: chatId });
  const attached = [];
  registerBrowserLogins(app, {
    auth,
    chats: { read: async () => ({ projectId }) },
    client: {
      state: async () => ({ sessionId, logins: loaded }),
      siteState: async () => exported,
      loadLogin: async (id, login) => (attached.push([id, login.id]), {}),
    },
    logins: {
      capabilities: () => ({ enabled: true }),
      list: async () => [{ id: shared, canManage: false }],
      save: async (_workspace, _user, input) => summary(input),
    },
  });
  const save = site =>
    app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/conversations/${chatId}/browser/logins`,
      payload: { name: 'Mine', site },
      headers: { cookie: 'session=member', origin: 'http://localhost:5173' },
    });
  return { save, attached, sessionId };
}

test('a saved login is attached to the browser it came from', async t => {
  const { save, attached, sessionId } = setup(t, {
    exported: { cookies: [cookie('id', 'shop.example')], origins: [] },
  });
  const response = await save('shop.example');
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(attached, [[sessionId, response.json().id]]);
});

test('a sibling site cannot copy the parent-domain cookies of a login the member may only use', async t => {
  const { save, attached } = setup(t, {
    loaded: [{ id: shared, site: 'accounts.shop.example', signedOut: false }],
    exported: { cookies: [cookie('id', '.shop.example')], origins: [] },
  });
  const response = await save('checkout.shop.example');
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'browser-login-unavailable');
  assert.deepEqual(attached, []);
});

test('logins are not saved from a project chat, which other members can watch', async t => {
  const { save } = setup(t, {
    projectId: randomUUID(),
    exported: { cookies: [cookie('id', 'shop.example')], origins: [] },
  });
  const response = await save('shop.example');
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'browser-login-project-chat');
});
