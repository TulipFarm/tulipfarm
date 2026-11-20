import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKeepClient, keepMemberScope } from '../dist/index.js';

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

test('memory writes send compare-and-swap and idempotency fields, and conflicts carry the current head', async () => {
  const requests = [];
  const answers = [
    json(200, {
      memoryId: 'm1',
      head: { revisionId: 'r2', version: '2' },
      seq: 7,
      treeRevision: 3,
      changed: true,
      replayed: false,
      scope: 'user/u',
      path: '/profile.md',
      created: false,
      revisionId: 'r2',
    }),
    json(409, {
      error: {
        code: 'conflict',
        message: 'stale',
        retryable: false,
        reason: 'VERSION_CONFLICT',
        details: { current: { revisionId: 'r3', version: '3' } },
      },
    }),
  ];
  const client = createKeepClient({
    endpoint,
    token: 'secret-token',
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
      return answers.shift();
    },
  });
  const input = {
    scope: { user: 'u' },
    path: '/profile.md',
    text: 'Short replies.',
    expectedRevisionId: 'r1',
    idempotencyKey: 'k1',
  };
  const written = await client.write(input);
  assert.equal(written.status, 'ok');
  assert.equal(written.value.seq, 7);
  assert.deepEqual(requests[0].body, {
    scope: { user: 'u' },
    path: '/profile.md',
    text: 'Short replies.',
    expected_revision_id: 'r1',
    idempotency_key: 'k1',
  });
  assert.equal(requests[0].url, 'http://keep.test/v1/memory/write');
  assert.equal(requests[0].auth, 'Bearer secret-token');
  assert.deepEqual(await client.write(input), {
    status: 'conflict',
    reason: 'VERSION_CONFLICT',
    current: { revisionId: 'r3', version: '3' },
  });
});

test('memory refusals are typed and never include the token or the text', async () => {
  const refuse = (status, code) => async () => json(status, { error: { code, message: 'x', retryable: false } });
  const read = fetch =>
    createKeepClient({ endpoint, token: 'secret-token', fetch }).read({ scope: { user: 'u' }, path: '/profile.md' });
  assert.deepEqual(await read(refuse(404, 'not_found')), { status: 'not_found' });
  assert.deepEqual(await read(refuse(503, 'unavailable')), {
    status: 'unavailable',
    reason: 'not_ready',
    code: 'unavailable',
  });
  assert.deepEqual(await read(refuse(401, 'unauthorized')), {
    status: 'unavailable',
    reason: 'rejected',
    code: 'unauthorized',
  });
  assert.deepEqual(await read(refuse(422, 'limit_exceeded')), { status: 'rejected', code: 'limit_exceeded' });
  assert.deepEqual(await read(async () => json(200, { text: 'no head' })), {
    status: 'unavailable',
    reason: 'invalid_response',
  });
  const forgotten = await createKeepClient({
    endpoint,
    token: 'secret-token',
    fetch: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), { scope: { user: 'u' }, path: '/profile.md', text: 'secret preference' });
      return json(200, {
        scope: 'user/u',
        receipt: {
          erasureSeq: 4,
          generation: 1,
          filesAffected: ['m1'],
          filesPurged: [],
          revisionsPurged: 2,
          receiptsRetired: 0,
          recovery: 'single_store',
        },
      });
    },
  }).forget({ scope: { user: 'u' }, path: '/profile.md', text: 'secret preference' });
  assert.deepEqual(forgotten, {
    status: 'ok',
    value: { erasureSeq: 4, filesAffected: ['m1'], filesPurged: [], revisionsPurged: 2 },
  });
  assert.ok(!JSON.stringify(forgotten).includes('secret'));
});

test('member scopes are keyed by workspace and membership and reject other ids', () => {
  const workspaceId = '11111111-2222-4333-8444-555555555555';
  const membershipId = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
  assert.deepEqual(keepMemberScope(workspaceId, membershipId), {
    user: 'ws-10dgnsy3z9iusugm9nn175rh1-m-a3qmm1chven4q4l58suabghda',
  });
  const widest = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  assert.ok(keepMemberScope(widest, widest).user.length <= 64);
  assert.throws(() => keepMemberScope(workspaceId, '../other'), TypeError);
  assert.throws(() => keepMemberScope('ws', membershipId), TypeError);
});
