import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { registerConversations } from '../src/conversations.ts';
import { registerSecurity } from '../src/security.ts';

const origin = 'http://localhost:5173';
const workspaceId = randomUUID();
const chatId = randomUUID();
const turnId = randomUUID();
const path = `/workspaces/${workspaceId}/conversations/${chatId}/events`;
const auth = {
  api: {
    getSession: async ({ headers }) =>
      headers.get('cookie') === 'session=valid' ? { session: { id: 'session' }, user: { id: 'user' } } : null,
  },
};
const preview = { turnId, generation: 1, epoch: 0, step: 0, seq: 2, offset: 0, text: 'Hello', reset: true };
const progress = { turnId, generation: 1, epoch: 0, step: 0, round: 1 };

function fakeHub({ healthy = true, snapshot = [] } = {}) {
  const listeners = new Set();
  return {
    listeners,
    healthy: () => healthy,
    snapshot: (workspace, conversation) => (workspace === workspaceId && conversation === chatId ? snapshot : []),
    subscribe: (_workspace, _conversation, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: event => {
      for (const listener of listeners) listener(event);
    },
  };
}

function fakeService() {
  const state = { denied: false, reads: 0 };
  return {
    state,
    read: async () => {
      state.reads++;
      if (state.denied) throw new AccessDenied();
      return {};
    },
  };
}

async function start(t, { service = fakeService(), events, eventTiming, server = {} } = {}) {
  const app = Fastify(server);
  registerSecurity(app, origin);
  registerConversations(app, { auth, service, events, eventTiming });
  t.after(() => app.close());
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `${address}${path}` };
}

const open = (url, cookie = 'session=valid') => fetch(url, { headers: { cookie, origin } });

function reader(response) {
  const stream = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  return {
    get body() {
      return body;
    },
    async until(check, message) {
      while (!check(body)) {
        const { done, value } = await stream.read();
        if (done) assert.fail(`${message}; stream ended with ${JSON.stringify(body)}`);
        body += decoder.decode(value, { stream: true });
      }
    },
    async end() {
      for (;;) {
        const { done, value } = await stream.read();
        if (done) return body;
        body += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => stream.cancel(),
  };
}

test('event streams require a session, conversation access, and a healthy hub', async t => {
  const service = fakeService();
  const { url } = await start(t, { service, events: fakeHub() });
  const anonymous = await open(url, '');
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: 'sign-in-required' });

  service.state.denied = true;
  const hidden = await open(url);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: 'conversation-not-found' });

  const unhealthy = await start(t, { events: fakeHub({ healthy: false }) });
  const busy = await open(unhealthy.url);
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { error: 'conversation-events-unavailable' });

  const missing = await start(t);
  assert.equal((await open(missing.url)).status, 503);
});

test('an event stream sends the snapshot, then live events, and unsubscribes when the reader leaves', async t => {
  const events = fakeHub({
    snapshot: [
      { event: 'progress', data: progress },
      { event: 'text', data: preview },
    ],
  });
  const { url } = await start(t, { events, eventTiming: { heartbeatMs: 40 } });
  const response = await open(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  const stream = reader(response);
  await stream.until(body => body.includes('event: text'), 'snapshot arrives');
  events.emit({ event: 'text', data: { ...preview, seq: 3, offset: 5, text: ' there', reset: false } });
  events.emit({ event: 'changed', data: { turnId, settled: true } });
  await stream.until(body => body.includes('event: changed'), 'live events arrive');
  await stream.until(body => body.includes(': keepalive\n\n'), 'heartbeat arrives');
  assert.equal(
    stream.body.split(': keepalive\n\n')[0],
    [
      'retry: 2000\n\n',
      `event: progress\ndata: ${JSON.stringify(progress)}\n\n`,
      `event: text\ndata: ${JSON.stringify(preview)}\n\n`,
      `event: text\ndata: ${JSON.stringify({ ...preview, seq: 3, offset: 5, text: ' there', reset: false })}\n\n`,
      `event: changed\ndata: {"turnId":"${turnId}","settled":true}\n\n`,
    ].join(''),
  );
  assert.equal(events.listeners.size, 1);
  await stream.cancel();
  for (let attempt = 0; events.listeners.size && attempt < 100; attempt++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events.listeners.size, 0);
});

test('an event stream ends when a recheck finds access revoked', async t => {
  const service = fakeService();
  const events = fakeHub();
  const { url } = await start(t, { service, events, eventTiming: { recheckMs: 30 } });
  const stream = reader(await open(url));
  await stream.until(body => body.startsWith('retry: 2000\n\n'), 'stream opens');
  while (service.state.reads < 3) await new Promise(resolve => setTimeout(resolve, 5));
  service.state.denied = true;
  assert.equal(await stream.end(), 'retry: 2000\n\n');
  assert.equal(events.listeners.size, 0);
});

test('heartbeats keep a stream past the connection and request timeouts until its lifetime ends', async t => {
  const events = fakeHub();
  // Fastify ignores its timeout options with a server factory, so the factory applies both and checks the request timeout often.
  const serverFactory = handler =>
    createServer({ requestTimeout: 120, connectionsCheckingInterval: 20 }, handler).setTimeout(120);
  const { url } = await start(t, {
    events,
    eventTiming: { heartbeatMs: 40, lifetimeMs: 400 },
    server: { serverFactory },
  });
  const started = Date.now();
  const body = await reader(await open(url)).end();
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 380 && elapsed < 2_000, `stream lasted ${elapsed} ms`);
  assert.ok(body.split(': keepalive\n\n').length >= 6, body);
  assert.equal(events.listeners.size, 0);
});

test('without heartbeats the connection timeout would cut the stream', async t => {
  const { url } = await start(t, {
    events: fakeHub(),
    eventTiming: { heartbeatMs: 10_000, lifetimeMs: 2_000 },
    server: { connectionTimeout: 120 },
  });
  const started = Date.now();
  const response = await open(url);
  await assert.rejects(reader(response).end());
  assert.ok(Date.now() - started < 1_000);
});

test('closing the server ends open event streams', async t => {
  const events = fakeHub();
  const { app, url } = await start(t, { events });
  const stream = reader(await open(url));
  await stream.until(body => body.startsWith('retry: 2000\n\n'), 'stream opens');
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 1_000);
  assert.equal(await stream.end(), 'retry: 2000\n\n');
  assert.equal(events.listeners.size, 0);
});
