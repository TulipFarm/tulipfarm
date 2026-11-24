import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { BrowserHostError, browserSessionId } from '@tulipfarm/browser';
import { registerBrowserLive } from '../src/browser-live.ts';

const origin = 'http://localhost:5173';
const auth = {
  api: {
    getSession: async ({ headers }) =>
      headers.get('cookie') === 'session=reader' ? { session: { id: 's' }, user: { id: 'reader' } } : null,
  },
};

function setup(t, client, readable = () => true) {
  const app = Fastify();
  t.after(() => app.close());
  const workspaceId = randomUUID();
  const chatId = randomUUID();
  registerBrowserLive(app, {
    auth,
    chats: {
      read: async (workspace, user, chat) => {
        assert.deepEqual([workspace, chat], [workspaceId, chatId]);
        if (user !== 'reader' || !readable()) throw new AccessDenied();
        return {};
      },
    },
    client,
  });
  const base = `/workspaces/${workspaceId}/conversations/${chatId}/browser`;
  const sessionId = browserSessionId(workspaceId, { conversationId: chatId });
  const as = (method, url, payload, cookie = 'session=reader') =>
    app.inject({ method, url: `${base}${url}`, payload, headers: { cookie, origin } });
  return { app, as, sessionId };
}

const state = sessionId => ({
  sessionId,
  url: 'https://example.com/',
  title: 'Example',
  controller: 'agent',
  needsPerson: 'Tick the terms box',
  controlledBy: null,
});

test('a reader sees the chat browser, takes it over as themselves and hands it back', async t => {
  const calls = [];
  let fixture;
  const client = {
    state: async id => (calls.push(['state', id]), state(id)),
    control: async (id, control) => (
      calls.push(['control', id, control]),
      { ...state(id), controller: control.controller }
    ),
    input: async (id, input) => calls.push(['input', id, input]),
  };
  fixture = setup(t, client);
  const { as, sessionId } = fixture;
  assert.deepEqual((await as('GET', '')).json(), { browser: state(sessionId) });
  assert.equal((await as('POST', '/control', { controller: 'person' })).json().browser.controller, 'person');
  const click = { type: 'mouse', event: 'mousePressed', x: 300, y: 440, button: 'left', clickCount: 1 };
  const sent = await as('POST', '/input', click);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal((await as('POST', '/control', { controller: 'agent' })).statusCode, 200);
  assert.deepEqual(calls[1], ['control', sessionId, { controller: 'person', memberId: 'reader' }]);
  assert.equal(calls[2][0], 'input');
  assert.deepEqual(calls[3], ['control', sessionId, { controller: 'agent' }]);
});

test('others get nothing, a forged member is ignored and host refusals map to statuses', async t => {
  let readable = true;
  const client = {
    state: async () => null,
    control: async () => {
      throw new BrowserHostError('session-not-found', 'No session', 404);
    },
    input: async () => {
      throw new BrowserHostError('agent-in-control', 'Take over first', 409);
    },
  };
  const { as } = setup(t, client, () => readable);
  assert.equal((await as('GET', '', undefined, 'session=other')).statusCode, 401);
  assert.deepEqual((await as('GET', '')).json(), { browser: null });
  assert.equal((await as('POST', '/control', { controller: 'person', memberId: 'someone-else' })).statusCode, 400);
  assert.equal((await as('POST', '/control', { controller: 'person' })).statusCode, 404);
  const input = await as('POST', '/input', { type: 'text', text: 'hi' });
  assert.deepEqual([input.statusCode, input.json()], [409, { error: 'agent-in-control' }]);
  readable = false;
  assert.equal((await as('GET', '')).statusCode, 404);
  const foreign = await as('POST', '/control', { controller: 'person' }, 'session=reader');
  assert.equal(foreign.statusCode, 404);
});

test('without a browser host a chat has no browser', async t => {
  const { as } = setup(t, undefined);
  assert.deepEqual((await as('GET', '')).json(), { browser: null });
  assert.deepEqual((await as('POST', '/control', { controller: 'person' })).json(), { error: 'browser-unavailable' });
});

test('the live view relays the host stream', async t => {
  const client = {
    frames: async (_id, signal) => {
      assert.equal(signal.aborted, false);
      return new Response('event: state\ndata: {}\n\nevent: frame\ndata: {"data":"AAAA"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  };
  const { as } = setup(t, client);
  const live = await as('GET', '/live');
  assert.equal(live.statusCode, 200);
  assert.match(live.headers['content-type'], /text\/event-stream/);
  assert.match(live.body, /event: frame/);
});
