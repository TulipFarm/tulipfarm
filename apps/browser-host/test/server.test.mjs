import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { HostError } from '../src/host.ts';
import { createBrowserHostServer } from '../src/server.ts';

const token = 'test-token-0123456789-0123456789-abcdef';
const sessionId = '00000000-0000-4000-8000-000000000001';
const state = {
  sessionId,
  url: 'about:blank',
  title: '',
  controller: 'agent',
  needsPerson: null,
  controlledBy: null,
};

async function serve(host) {
  const server = createBrowserHostServer({ size: () => 0, ...host }, token);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    });
  return { server, base, call };
}

test('every route except health needs the bearer token', async t => {
  const { server, base } = await serve({ open: async () => state });
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const denied = await fetch(`${base}/v1/sessions`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong' },
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(denied.status, 401);
});

test('actions are validated before they reach the browser', async t => {
  const acted = [];
  const { server, call } = await serve({ act: async (id, action) => (acted.push(action), { state }) });
  t.after(() => server.close());
  const bad = await call(`/v1/sessions/${sessionId}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action: 'navigate', url: 'file:///etc/passwd' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid-request');
  const ok = await call(`/v1/sessions/${sessionId}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action: 'type', ref: 'e3', text: 'hello' }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(acted, [{ action: 'type', ref: 'e3', text: 'hello', submit: false }]);
});

test('host errors keep their code and status', async t => {
  const { server, call } = await serve({
    act: async () => {
      throw new HostError('person-in-control', 'A member has taken over.', 409);
    },
  });
  t.after(() => server.close());
  const response = await call(`/v1/sessions/${sessionId}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action: 'snapshot' }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'person-in-control', message: 'A member has taken over.' });
});

test('the live view streams state and frames as server-sent events', async t => {
  let unsubscribed = false;
  const { server, call } = await serve({
    subscribe: async (id, listener) => {
      listener({ type: 'state', state });
      listener({ type: 'frame', frame: { data: 'abc', width: 1280, height: 800 } });
      return () => {
        unsubscribed = true;
      };
    },
  });
  t.after(() => server.close());
  const controller = new AbortController();
  const response = await call(`/v1/sessions/${sessionId}/frames`, { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('event: frame')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: state\ndata: \{"sessionId"/);
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(unsubscribed, true);
});
