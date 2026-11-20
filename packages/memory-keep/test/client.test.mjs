import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKeepClient } from '../dist/index.js';

const endpoint = new URL('http://keep.test');
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('health is available only when Keep reports ready, and sends no token', async () => {
  const requests = [];
  const client = createKeepClient({
    endpoint,
    token: 'secret-token',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return json(200, { status: 'ready', version: '0.1.0', checks: { ledger: 'ok', vectors: 'none' } });
    },
  });
  assert.deepEqual(await client.health(), { status: 'available', version: '0.1.0' });
  assert.equal(requests[0].url, 'http://keep.test/v1/health/ready');
  assert.equal(requests[0].init.headers.authorization, undefined);
  assert.equal(requests[0].init.redirect, 'error');
});

test('health failures are typed unavailable states', async () => {
  const health = fetch => createKeepClient({ endpoint, fetch }).health();
  assert.deepEqual(await health(async () => json(503, { status: 'unavailable' })), {
    status: 'unavailable',
    reason: 'not_ready',
  });
  assert.deepEqual(
    await health(async () => {
      throw new TypeError('fetch failed');
    }),
    { status: 'unavailable', reason: 'unreachable' },
  );
  assert.deepEqual(await health(async () => json(200, { status: 'ok' })), {
    status: 'unavailable',
    reason: 'invalid_response',
  });
  const slow = createKeepClient({
    endpoint,
    timeoutMs: 10,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  });
  assert.deepEqual(await slow.health(), { status: 'unavailable', reason: 'timeout' });
});

test('memory context sends the bearer token and maps Keep errors to their code', async () => {
  const requests = [];
  const answers = [
    json(200, { text: 'profile', tokens: 3, scope: 'user/alex', notes: [], budget: {} }),
    json(401, { error: { code: 'unauthorized', message: 'missing token', retryable: false } }),
    json(503, { error: { code: 'unavailable', message: 'storage', retryable: true } }),
  ];
  const client = createKeepClient({
    endpoint,
    token: 'secret-token',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return answers.shift();
    },
  });
  const input = { scope: { user: 'alex' }, query: 'billing', budgetTokens: 512 };
  assert.deepEqual(await client.memoryContext(input), {
    status: 'ok',
    value: { text: 'profile', tokens: 3, scope: 'user/alex', notes: [] },
  });
  assert.equal(requests[0].url, 'http://keep.test/v1/memory/context');
  assert.equal(requests[0].init.headers.authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    scope: { user: 'alex' },
    query: 'billing',
    budget_tokens: 512,
  });
  assert.deepEqual(await client.memoryContext(input), {
    status: 'unavailable',
    reason: 'rejected',
    code: 'unauthorized',
  });
  assert.deepEqual(await client.memoryContext(input), {
    status: 'unavailable',
    reason: 'not_ready',
    code: 'unavailable',
  });
});
