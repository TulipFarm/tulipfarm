import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserHostError, browserSessionId, createBrowserHostClient } from '../src/index.ts';

const workspaceId = '6f1c2b8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const conversationId = '0b0e7a51-3c5d-4b8e-9f21-6d2a7c4e1f00';

test('a chat and a run each reach one stable browser session', () => {
  const chat = browserSessionId(workspaceId, { conversationId });
  assert.equal(chat, browserSessionId(workspaceId, { conversationId }));
  assert.match(chat, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(chat, browserSessionId(workspaceId, { runId: conversationId }));
  assert.notEqual(chat, browserSessionId(conversationId, { conversationId: workspaceId }));
});

const respond =
  (status, body, type = 'application/json') =>
  async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
const client = fetchImpl =>
  createBrowserHostClient({ endpoint: 'http://host.test', headers: { authorization: 'Bearer t' } }, fetchImpl);

test('host errors keep their code, and a missing session reads as none', async () => {
  const busy = client(respond(409, { error: 'person-in-control', message: 'A member controls this browser' }));
  await assert.rejects(busy.act('s', { action: 'snapshot' }), error => {
    assert.ok(error instanceof BrowserHostError);
    assert.equal(error.code, 'person-in-control');
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(await client(respond(404, { error: 'session-not-found', message: 'No session' })).state('s'), null);
  await client(respond(404, { error: 'session-not-found', message: 'No session' })).close('s');
});

test('an unreachable host, a refused token or an unreadable answer is unavailable', async () => {
  const cases = [
    client(async () => {
      throw new TypeError('fetch failed');
    }),
    client(respond(502, '<html>Bad gateway</html>', 'text/html')),
    client(respond(200, 'not json', 'text/plain')),
    client(respond(401, { error: 'invalid-request', message: 'Unauthorized' })),
  ];
  for (const host of cases)
    await assert.rejects(host.open('s'), error => error instanceof BrowserHostError && error.code === 'unavailable');
  await assert.rejects(
    cases[0].frames('s', new AbortController().signal),
    error => error instanceof BrowserHostError && error.code === 'unavailable',
  );
});
