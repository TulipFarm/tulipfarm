import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { BrowserHostError, browserSessionId } from '@tulipfarm/browser';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { browserDiscard, registerBrowserLive } from '../src/browser-live.ts';
import { registerConversations } from '../src/conversations.ts';

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

test('browserDiscard closes the session and ends billing without failing on host errors', async t => {
  const workspaceId = randomUUID();
  const chatId = randomUUID();
  const runId = randomUUID();
  const closed = [];
  const queries = [];
  const logged = [];
  const runtime = {
    async transaction(ws, _compat, action) {
      return action({
        schema: 'ws_test',
        commonVersion: 112,
        client: {
          async query(sql, params) {
            queries.push({ ws, sql, params });
            return { rows: [], rowCount: 0 };
          },
        },
      });
    },
  };
  assert.equal(
    browserDiscard(undefined, runtime, () => {}),
    undefined,
  );
  registerExtension({
    name: 'test-meter',
    register(api) {
      api.resourceMeter({
        pricing: {
          databasePicoUsdPerGibMonth: 0n,
          objectPicoUsdPerGibMonth: 0n,
          runPicoUsdPerHour: 0n,
          browserPicoUsdPerHour: 0n,
        },
        databaseBytes: async function* () {},
        objectBytes: async function* () {},
      });
    },
  });
  t.after(() => resetExtensions());
  const discard = browserDiscard(
    {
      close: async id => {
        closed.push(id);
        if (id === browserSessionId(workspaceId, { runId })) throw new Error('host-down');
      },
    },
    runtime,
    (error, ws) => logged.push([ws, error.message]),
  );
  await discard(workspaceId, { conversationId: chatId });
  await discard(workspaceId, { runId });
  assert.deepEqual(closed, [
    browserSessionId(workspaceId, { conversationId: chatId }),
    browserSessionId(workspaceId, { runId }),
  ]);
  assert.deepEqual(logged, [[workspaceId, 'host-down']]);
  const updates = queries.filter(q => q.sql.includes('tf_browser_usage'));
  assert.equal(updates.length, 2, 'billing ends for both chat delete and run cancel even if host close fails');
  assert.equal(updates[0].params[0], browserSessionId(workspaceId, { conversationId: chatId }));
  assert.equal(updates[1].params[0], browserSessionId(workspaceId, { runId }));
});

test('deleting a chat closes its browser session after removal succeeds', async t => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY ??= 'test-placeholder';
  t.after(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });
  const app = Fastify();
  t.after(() => app.close());
  const workspaceId = randomUUID();
  const chatId = randomUUID();
  const closed = [];
  let allow = true;
  registerConversations(app, {
    auth,
    service: {
      remove: async () => {
        if (!allow) throw new AccessDenied();
        return { deleted: true };
      },
    },
    closeBrowser: async (ws, chat) => {
      closed.push([ws, chat]);
    },
  });
  const del = () =>
    app.inject({
      method: 'DELETE',
      url: `/workspaces/${workspaceId}/conversations/${chatId}`,
      payload: { commandId: randomUUID() },
      headers: { cookie: 'session=reader', origin },
    });
  assert.equal((await del()).statusCode, 200);
  assert.deepEqual(closed, [[workspaceId, chatId]]);
  allow = false;
  assert.equal((await del()).statusCode, 404);
  assert.equal(closed.length, 1, 'a refused delete does not close the browser');
});
