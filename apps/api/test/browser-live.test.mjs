import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { BrowserHostError, browserSessionId } from '@tulipfarm/browser';
import { registerBrowserLive } from '../src/browser-live.ts';
import { deliverTaskWake } from '../src/task-dispatch.ts';

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
  controller: 'agent',
  needsPerson: 'Tick the terms box',
  controlledBy: null,
  signIn: null,
  logins: [],
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
  // Keys typed while a request is out go together, in order.
  const keys = ['keyDown', 'keyUp'].map(event => ({ type: 'key', event, key: 'a', code: 'KeyA', modifiers: 0 }));
  assert.equal((await as('POST', '/input', keys)).statusCode, 200);
  assert.equal((await as('POST', '/input', [])).statusCode, 400);
  assert.equal((await as('POST', '/control', { controller: 'agent' })).statusCode, 200);
  assert.deepEqual(calls[1], ['control', sessionId, { controller: 'person', memberId: 'reader' }]);
  assert.equal(calls[2][0], 'input');
  assert.deepEqual(calls[3], ['input', sessionId, keys]);
  assert.deepEqual(calls[4], ['control', sessionId, { controller: 'agent' }]);
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

test('whoever can see a run watches and takes over its browser, and handing it back wakes the run', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const calls = [];
  const woken = [];
  const recorded = [];
  registerBrowserLive(app, {
    auth,
    chats: { read: async () => assert.fail('a run is not a chat') },
    tasks: {
      read: async (workspace, user, task) => {
        if (workspace !== workspaceId || task !== taskId || user !== 'reader') throw new AccessDenied();
        return {};
      },
      handBack: async (workspace, task) => recorded.push([workspace, task]),
      wake: async (workspace, task) => woken.push([workspace, task]),
    },
    client: {
      state: async id => (calls.push(['state', id]), state(id)),
      control: async (id, control) => (
        calls.push(['control', id, control]),
        { ...state(id), controller: control.controller }
      ),
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
  assert.equal((await as('POST', taskId, '/control', { controller: 'person' })).json().browser.controller, 'person');
  assert.deepEqual(woken, [], 'taking over does not wake the run');
  assert.equal((await as('POST', taskId, '/control', { controller: 'agent' })).statusCode, 200);
  assert.deepEqual(woken, [[workspaceId, taskId]]);
  assert.deepEqual(recorded, [[workspaceId, taskId]], 'the hand back is recorded on the run');
  assert.deepEqual(calls[1], ['control', sessionId, { controller: 'person', memberId: 'reader' }]);

  const other = await as('POST', randomUUID(), '/control', { controller: 'person' });
  assert.deepEqual([other.statusCode, other.json()], [404, { error: 'task-not-found' }]);
  assert.equal(calls.length, 3, "a run the member can't see never reaches the host");
});

test('a hand back that neither records nor wakes the run is an error, while either one alone resumes it', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  let record = async () => undefined;
  let wake = async () => undefined;
  registerBrowserLive(app, {
    auth,
    chats: { read: async () => assert.fail('a run is not a chat') },
    tasks: { read: async () => ({}), handBack: (...a) => record(...a), wake: (...a) => wake(...a) },
    client: { control: async (id, control) => ({ ...state(id), controller: control.controller }) },
  });
  const handBack = () =>
    app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agent-tasks/${taskId}/browser/control`,
      payload: { controller: 'agent' },
      headers: { cookie: 'session=reader', origin },
    });
  const failing = async () => {
    throw new Error('unavailable');
  };
  wake = failing;
  assert.equal((await handBack()).statusCode, 200, 'a recorded hand back resumes the run without its wake');
  record = failing;
  wake = async () => undefined;
  assert.equal((await handBack()).statusCode, 200, 'a delivered wake resumes the run');
  wake = failing;
  const lost = await handBack();
  assert.deepEqual([lost.statusCode, lost.json()], [503, { error: 'browser-unavailable' }]);
});

test('the run wake Temporal refuses fails a hand back that could not be recorded', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const signalled = [];
  let refuse = true;
  const temporal = {
    connection: { withDeadline: (_deadline, send) => send() },
    client: {
      workflow: {
        signalWithStart: async (workflow, options) => {
          if (refuse) throw new Error('temporal unavailable');
          signalled.push([workflow, options.workflowId, options.signal]);
        },
      },
    },
  };
  registerBrowserLive(app, {
    auth,
    chats: { read: async () => assert.fail('a run is not a chat') },
    tasks: {
      read: async () => ({}),
      handBack: async () => {
        throw new Error('database unavailable');
      },
      wake: deliverTaskWake(temporal),
    },
    client: { control: async (id, control) => ({ ...state(id), controller: control.controller }) },
  });
  const handBack = () =>
    app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agent-tasks/${taskId}/browser/control`,
      payload: { controller: 'agent' },
      headers: { cookie: 'session=reader', origin },
    });
  const lost = await handBack();
  assert.deepEqual([lost.statusCode, lost.json()], [503, { error: 'browser-unavailable' }]);
  refuse = false;
  assert.equal((await handBack()).statusCode, 200);
  assert.deepEqual(signalled, [['agentTaskStep', `agent-task-v1-${workspaceId}-${taskId}`, 'wakeAgentTask']]);
});

test("a person's use of the browser is recorded for its charge", async t => {
  const recorded = [];
  const client = {
    state: async id => state(id),
    control: async (id, control) => ({ ...state(id), controller: control.controller }),
  };
  const { as, sessionId, workspaceId } = setup(t, client, undefined, async (...use) => {
    recorded.push(use);
  });
  await as('GET', '');
  await as('POST', '/control', { controller: 'person' });
  assert.deepEqual(
    recorded.map(([workspace, session, browser]) => [workspace, session, browser.controller]),
    [
      [workspaceId, sessionId, 'agent'],
      [workspaceId, sessionId, 'person'],
    ],
  );
});
