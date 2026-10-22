import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import {
  PlatformFetchError,
  classify,
  classifyFailure,
  createPlatformFetch,
  platformFetchTimeouts,
  rateLimitReset,
} from '../dist/platform-fetch.js';

const token = 'secret-access-token';
let server;
let origin;
const hits = [];

before(async () => {
  server = createServer((request, response) => {
    hits.push(request.url);
    if (request.url.startsWith('/redirect')) {
      response.writeHead(302, { location: 'https://evil.example/' });
      return response.end();
    }
    if (request.url.startsWith('/slow')) return setTimeout(() => response.end('late'), 500);
    response.writeHead(200, { 'x-request-id': 'req-123', 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const local = (extra = {}) => {
  const records = [];
  const fetch = createPlatformFetch({
    platform: 'x',
    hosts: ['127.0.0.1'],
    allowLoopbackHttp: true,
    record: entry => records.push(entry),
    ...extra,
  });
  return { fetch, records };
};

test('defaults are a 15 second timeout and a longer upload-chunk timeout', () => {
  assert.equal(platformFetchTimeouts.defaultMs, 15_000);
  assert.ok(platformFetchTimeouts.uploadChunkMs > platformFetchTimeouts.defaultMs);
});

test('a host outside the allow-list is refused before anything is sent', async () => {
  let called = false;
  const fetch = createPlatformFetch({
    platform: 'x',
    hosts: ['api.x.com'],
    fetch: async () => {
      called = true;
      return new Response('');
    },
  });
  for (const target of [
    'https://evil.example/2/tweets',
    'https://api.x.com.evil.example/',
    'http://api.x.com/2/tweets',
    'https://user:pass@api.x.com/',
    'not a url',
  ]) {
    const error = await fetch(target, { purpose: 'mutate', method: 'POST' }).catch(error => error);
    assert.ok(error instanceof PlatformFetchError, target);
    assert.equal(error.code, 'host-not-allowed');
    assert.equal(error.phase, 'before-send');
    assert.equal(classify(error, error.phase), 'rejected');
  }
  assert.equal(called, false);
  const before = hits.length;
  const { fetch: loopback } = local({ allowLoopbackHttp: false });
  await assert.rejects(loopback(`${origin}/ok`, { purpose: 'read' }), { code: 'host-not-allowed' });
  assert.equal(hits.length, before);
});

test('allowed requests use redirect: error and the caller cannot override it', async () => {
  let seen;
  const fetch = createPlatformFetch({
    platform: 'x',
    hosts: ['api.x.com'],
    fetch: async (_url, init) => {
      seen = init;
      return new Response('{}', { status: 200 });
    },
  });
  await fetch('https://API.x.com/2/tweets', { purpose: 'mutate', method: 'post', redirect: 'follow', body: '{}' });
  assert.equal(seen.redirect, 'error');
  assert.equal(seen.method, 'POST');
  assert.ok(seen.signal instanceof AbortSignal);
});

test('a redirect is refused and not followed', async () => {
  const { fetch, records } = local();
  const before = hits.length;
  const error = await fetch(`${origin}/redirect`, { purpose: 'read' }).catch(error => error);
  assert.ok(error instanceof PlatformFetchError);
  assert.equal(error.code, 'redirect-refused');
  assert.equal(hits.length, before + 1);
  assert.equal(records.at(-1).failure, 'redirect-refused');
  assert.equal(classifyFailure(error, { phase: error.phase, purpose: 'read' }).class, 'rejected');
});

test('a 3xx response from an injected fetch is also refused', async () => {
  const fetch = createPlatformFetch({
    platform: 'x',
    hosts: ['api.x.com'],
    fetch: async () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } }),
  });
  await assert.rejects(fetch('https://api.x.com/', { purpose: 'read' }), { code: 'redirect-refused' });
});

test('requests time out, with a separate limit for upload chunks', async () => {
  const { fetch, records } = local({ timeoutMs: 50, uploadTimeoutMs: 2_000 });
  const error = await fetch(`${origin}/slow`, { purpose: 'mutate', method: 'POST' }).catch(error => error);
  assert.equal(error.code, 'timeout');
  assert.equal(error.phase, 'after-send');
  assert.equal(records.at(-1).failure, 'timeout');
  const verdict = classifyFailure(error, { phase: error.phase, purpose: 'mutate' });
  assert.deepEqual(verdict, { class: 'unknown', resetAt: null, retryable: false, outcomeUnknown: true });
  const chunk = await fetch(`${origin}/slow`, { purpose: 'upload-chunk', method: 'PUT', body: 'x' });
  assert.equal(await chunk.text(), 'late');
  await assert.rejects(fetch(`${origin}/slow`, { purpose: 'read', timeoutMs: 20 }), { code: 'timeout' });
});

test('a caller abort is reported as aborted', async () => {
  const { fetch } = local();
  const controller = new AbortController();
  const pending = fetch(`${origin}/slow`, { purpose: 'read', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
});

test('records keep the request ID but no body, query, header or token', async () => {
  const { fetch, records } = local({ requestIdHeaders: ['x-request-id'] });
  const response = await fetch(`${origin}/ok?access_token=${token}`, {
    purpose: 'mutate',
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: 'private draft', token }),
  });
  assert.equal(response.status, 200);
  const record = records.at(-1);
  assert.deepEqual(Object.keys(record).sort(), [
    'durationMs',
    'failure',
    'host',
    'method',
    'platform',
    'purpose',
    'requestId',
    'status',
  ]);
  assert.equal(record.requestId, 'req-123');
  assert.equal(record.host, '127.0.0.1');
  const serialized = JSON.stringify(records);
  for (const secret of [token, 'private draft', 'access_token', 'Bearer'])
    assert.equal(serialized.includes(secret), false);
});

test('a network failure before connecting is before-send; after is after-send', async () => {
  const failing = code =>
    createPlatformFetch({
      platform: 'x',
      hosts: ['api.x.com'],
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
      },
    });
  const refused = await failing('ECONNREFUSED')('https://api.x.com/', { purpose: 'mutate', method: 'POST' }).catch(
    e => e,
  );
  assert.equal(refused.phase, 'before-send');
  assert.deepEqual(classifyFailure(refused, { phase: refused.phase, purpose: 'mutate' }), {
    class: 'retry',
    resetAt: null,
    retryable: false,
    outcomeUnknown: false,
  });
  const reset = await failing('ECONNRESET')('https://api.x.com/', { purpose: 'mutate', method: 'POST' }).catch(e => e);
  assert.equal(reset.phase, 'after-send');
  assert.equal(classifyFailure(reset, { phase: reset.phase, purpose: 'mutate' }).outcomeUnknown, true);
});

const now = new Date('2026-06-01T00:00:00.000Z');
const response = (status, headers = {}) => new Response(null, { status, headers });

test('classify matrix', () => {
  const network = new PlatformFetchError('network', 'after-send');
  const rows = [
    // [failure, phase, purpose, class, retryable, outcomeUnknown]
    [response(401), 'after-send', 'mutate', 'reconnect', false, false],
    [response(401), 'after-send', 'read', 'reconnect', false, false],
    [response(429), 'after-send', 'read', 'rate-limited', true, false],
    [response(429), 'after-send', 'mutate', 'rate-limited', false, false],
    [response(400), 'after-send', 'mutate', 'rejected', false, false],
    [response(403), 'after-send', 'read', 'rejected', false, false],
    [response(404), 'after-send', 'await', 'rejected', false, false],
    [response(422), 'after-send', 'mutate', 'rejected', false, false],
    [response(500), 'after-send', 'read', 'retry', true, false],
    [response(503), 'after-send', 'await', 'retry', true, false],
    [response(502), 'after-send', 'refresh', 'retry', true, false],
    [response(504), 'after-send', 'range-query', 'retry', true, false],
    [response(500), 'after-send', 'mutate', 'unknown', false, true],
    [response(408), 'after-send', 'upload-chunk', 'unknown', false, true],
    [response(500), 'before-send', 'mutate', 'retry', false, false],
    [network, 'after-send', 'read', 'retry', true, false],
    [network, 'after-send', 'mutate', 'unknown', false, true],
    [network, 'before-send', 'mutate', 'retry', false, false],
    [new Error('boom'), 'after-send', 'mutate', 'unknown', false, true],
    [new Error('boom'), 'after-send', 'read', 'unknown', false, false],
  ];
  for (const [failure, phase, purpose, expected, retryable, outcomeUnknown] of rows) {
    const verdict = classifyFailure(failure, { phase, purpose, now });
    const label = `${failure.status ?? failure.message} ${phase} ${purpose}`;
    assert.equal(verdict.class, expected, label);
    assert.equal(verdict.retryable, retryable, label);
    assert.equal(verdict.outcomeUnknown, outcomeUnknown, label);
  }
  assert.equal(classify(response(500), 'after-send'), 'unknown');
  assert.equal(classify(response(500), 'after-send', 'read'), 'retry');
});

test('rate-limit reset times come from the response headers', () => {
  assert.equal(rateLimitReset(response(429, { 'retry-after': '30' }), now).toISOString(), '2026-06-01T00:00:30.000Z');
  assert.equal(
    rateLimitReset(response(429, { 'retry-after': 'Mon, 01 Jun 2026 00:05:00 GMT' }), now).toISOString(),
    '2026-06-01T00:05:00.000Z',
  );
  assert.equal(
    rateLimitReset(response(429, { 'x-rate-limit-reset': '1780272000' }), now).toISOString(),
    new Date(1780272000 * 1000).toISOString(),
  );
  assert.equal(
    rateLimitReset(response(429, { 'x-ratelimit-reset': '60' }), now).toISOString(),
    '2026-06-01T00:01:00.000Z',
  );
  assert.equal(rateLimitReset(response(429), now), null);
  const verdict = classifyFailure(response(429, { 'retry-after': '5' }), { phase: 'after-send', purpose: 'read', now });
  assert.equal(verdict.resetAt.toISOString(), '2026-06-01T00:00:05.000Z');
  assert.equal(
    classifyFailure(response(500, { 'retry-after': '5' }), { phase: 'after-send', purpose: 'read', now }).resetAt,
    null,
  );
});
