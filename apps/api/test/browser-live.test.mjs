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

function setup(t, client, readable = () => true, usage = undefined) {
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
    usage,
  });
  const base = `/workspaces/${workspaceId}/conversations/${chatId}/browser`;
  const sessionId = browserSessionId(workspaceId, { conversationId: chatId });
  const as = (method, url, payload, cookie = 'session=reader') =>
    app.inject({ method, url: `${base}${url}`, payload, headers: { cookie, origin } });
  return { app, as, sessionId, workspaceId };
}

const state = sessionId => ({
  sessionId,
  url: 'https://example.com/',
  title: 'Example',
  needsPerson: 'Tick the terms box',
  signIn: null,
  logins: [],
});

test('a reader sees the chat browser and clicks and types in it at any time', async t => {
  const calls = [];
  const client = {
    state: async id => (calls.push(['state', id]), state(id)),
    input: async (id, input) => calls.push(['input', id, input]),
  };
  const { as, sessionId } = setup(t, client);
  assert.deepEqual((await as('GET', '')).json(), { browser: state(sessionId) });
  const click = { type: 'mouse', event: 'mousePressed', x: 300, y: 440, button: 'left', clickCount: 1 };
  const sent = await as('POST', '/input', click);
  assert.equal(sent.statusCode, 200, sent.body);
  // Keys typed while a request is out go together, in order.
  const keys = ['keyDown', 'keyUp'].map(event => ({ type: 'key', event, key: 'a', code: 'KeyA', modifiers: 0 }));
  assert.equal((await as('POST', '/input', keys)).statusCode, 200);
  assert.equal((await as('POST', '/input', [])).statusCode, 400);
  assert.equal(calls[1][0], 'input');
  assert.deepEqual(calls[2], ['input', sessionId, keys]);
  assert.equal((await as('POST', '/control', { controller: 'person' })).statusCode, 404, 'there is no take-over');
});

test('others get nothing and host refusals map to statuses', async t => {
  let readable = true;
  const client = {
    state: async () => null,
    input: async () => {
      throw new BrowserHostError('session-not-found', 'No session', 404);
    },
  };
  const { as } = setup(t, client, () => readable);
  assert.equal((await as('GET', '', undefined, 'session=other')).statusCode, 401);
  assert.deepEqual((await as('GET', '')).json(), { browser: null });
  const input = await as('POST', '/input', { type: 'text', text: 'hi' });
  assert.deepEqual([input.statusCode, input.json()], [404, { error: 'browser-not-found' }]);
  readable = false;
  assert.equal((await as('GET', '')).statusCode, 404);
  assert.equal((await as('POST', '/input', { type: 'text', text: 'hi' })).statusCode, 404);
});

test('without a browser host a chat has no browser', async t => {
  const { as } = setup(t, undefined);
  assert.deepEqual((await as('GET', '')).json(), { browser: null });
  assert.deepEqual((await as('POST', '/input', { type: 'text', text: 'hi' })).json(), {
    error: 'browser-unavailable',
  });
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

test('whoever can see a run watches its browser and uses it', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const calls = [];
  registerBrowserLive(app, {
    auth,
    chats: { read: async () => assert.fail('a run is not a chat') },
    tasks: {
      read: async (workspace, user, task) => {
        if (workspace !== workspaceId || task !== taskId || user !== 'reader') throw new AccessDenied();
        return {};
      },
    },
    client: {
      state: async id => (calls.push(['state', id]), state(id)),
      input: async (id, input) => calls.push(['input', id, input]),
    },
  });
  const sessionId = browserSessionId(workspaceId, { runId: taskId });
  const as = (method, task, url, payload) =>
    app.inject({
      method,
      url: `/workspaces/${workspaceId}/agent-tasks/${task}/browser${url}`,
      payload,
      headers: { cookie: 'session=reader', origin },
    });
  assert.deepEqual((await as('GET', taskId, '')).json(), { browser: state(sessionId) });
  assert.equal((await as('POST', taskId, '/input', { type: 'text', text: 'hi' })).statusCode, 200);
  assert.deepEqual(calls[1], ['input', sessionId, { type: 'text', text: 'hi' }]);

  const other = await as('POST', randomUUID(), '/input', { type: 'text', text: 'hi' });
  assert.deepEqual([other.statusCode, other.json()], [404, { error: 'task-not-found' }]);
  assert.equal(calls.length, 2, "a run the member can't see never reaches the host");
});

test('watching a browser is recorded for its charge', async t => {
  const recorded = [];
  const client = { state: async id => state(id) };
  const { as, sessionId, workspaceId } = setup(t, client, undefined, async (...use) => {
    recorded.push(use);
  });
  await as('GET', '');
  assert.deepEqual(
    recorded.map(([workspace, session, browser]) => [workspace, session, browser.title]),
    [[workspaceId, sessionId, 'Example']],
  );
});
