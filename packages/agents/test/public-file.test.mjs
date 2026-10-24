import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { Agent, request } from 'undici';
import { fetchPublicFile, pinnedLookup, publicFileLimits, publicNetwork } from '../src/web-fetch.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Serves `routes` on a local port and routes every public link there. DNS answers come from `dns`; each connection
 * goes through the production pinned lookup, and the address it returned is recorded.
 */
async function localWeb(t, routes, dns = () => ['93.184.216.34']) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ host: request.headers.host, path: request.url, headers: request.headers });
    const route = routes[`${request.headers.host}${request.url}`];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    route(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const resolved = [];
  const connected = [];
  t.mock.method(publicNetwork, 'resolve', async hostname => {
    resolved.push(hostname);
    return dns(hostname, resolved.filter(name => name === hostname).length);
  });
  t.mock.method(
    publicNetwork,
    'dispatcher',
    pinned =>
      new Agent({
        connect(options, callback) {
          pinned(options.hostname, {}, (error, address) => {
            if (error) return callback(error, null);
            connected.push({ hostname: options.hostname, address });
            const socket = connect(port, '127.0.0.1');
            socket.once('connect', () => callback(null, socket)).once('error', cause => callback(cause, null));
          });
        },
      }),
  );
  const previous = process.env.FIRECRAWL_ENDPOINT;
  process.env.FIRECRAWL_ENDPOINT = 'https://firecrawl.example.com';
  t.after(() => {
    if (previous === undefined) delete process.env.FIRECRAWL_ENDPOINT;
    else process.env.FIRECRAWL_ENDPOINT = previous;
  });
  return { requests, resolved, connected };
}

const send =
  (status, body = '', headers = {}) =>
  (_request, response) =>
    response.writeHead(status, headers).end(body);

test('a public file is fetched once with no credentials and typed from its bytes', async t => {
  const web = await localWeb(t, {
    'files.example.com/chart': send(200, png, { 'content-type': 'application/octet-stream', 'set-cookie': 'a=b' }),
  });
  const file = await fetchPublicFile('https://files.example.com/chart', AbortSignal.timeout(5000));
  assert.equal(file.kind, 'file');
  assert.equal(file.mediaType, 'image/png');
  assert.equal(file.filename, 'chart');
  assert.deepEqual(Buffer.from(file.bytes), png);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  const [request] = web.requests;
  for (const header of ['cookie', 'authorization', 'referer', 'proxy-authorization'])
    assert.equal(request.headers[header], undefined);
  assert.deepEqual(web.connected, [{ hostname: 'files.example.com', address: '93.184.216.34' }]);
});

test('HTML is a page whatever its declared type, and other text is a file', async t => {
  await localWeb(t, {
    'site.example.com/declared': send(200, 'hello', { 'content-type': 'text/html; charset=utf-8' }),
    'site.example.com/sniffed': send(200, '<!doctype html><title>x</title>', { 'content-type': 'text/plain' }),
    'site.example.com/data.csv': send(200, 'a,b\n1,2\n', { 'content-type': 'text/csv' }),
  });
  const signal = AbortSignal.timeout(5000);
  assert.deepEqual(await fetchPublicFile('https://site.example.com/declared', signal), {
    kind: 'page',
    url: 'https://site.example.com/declared',
  });
  assert.equal((await fetchPublicFile('https://site.example.com/sniffed', signal)).kind, 'page');
  const csv = await fetchPublicFile('https://site.example.com/data.csv', signal);
  assert.equal(csv.kind, 'file');
  assert.equal(csv.mediaType, 'text/csv');
  assert.equal(csv.filename, 'data.csv');
});

test('a long link name is cut at 200 characters without splitting an emoji', async t => {
  const name = `a${'😀'.repeat(120)}`;
  await localWeb(t, {
    [`site.example.com/${encodeURIComponent(name)}`]: send(200, 'a,b\n', { 'content-type': 'text/csv' }),
  });
  const file = await fetchPublicFile(`https://site.example.com/${encodeURIComponent(name)}`, AbortSignal.timeout(5000));
  assert.equal(file.filename, `a${'😀'.repeat(99)}`);
});

test('401 and 403 need sign-in and other errors are unavailable', async t => {
  await localWeb(t, {
    'private.example.com/a': send(401),
    'private.example.com/b': send(403),
    'private.example.com/c': send(500),
  });
  const signal = AbortSignal.timeout(5000);
  for (const [path, reason] of [
    ['a', 'sign-in-required'],
    ['b', 'sign-in-required'],
    ['c', 'unavailable'],
    ['missing', 'unavailable'],
  ])
    assert.equal((await fetchPublicFile(`https://private.example.com/${path}`, signal)).reason, reason);
});

test('redirects are followed at most five times and every hop is checked again', async t => {
  const hops = {};
  for (let index = 0; index < 6; index++) {
    hops[`five.example.com/${index}`] = send(302, '', { location: `/${index + 1}` });
    hops[`six.example.com/${index}`] = send(302, '', { location: `/${index + 1}` });
  }
  hops['five.example.com/5'] = send(200, png);
  hops['six.example.com/6'] = send(200, png);
  const web = await localWeb(
    t,
    {
      ...hops,
      'start.example.com/private': send(301, '', { location: 'https://intranet.example.com/secret' }),
      'start.example.com/literal': send(302, '', { location: 'https://10.0.0.5/secret' }),
      'start.example.com/plain': send(302, '', { location: 'http://files.example.com/file' }),
      'intranet.example.com/secret': send(200, png),
    },
    hostname => (hostname === 'intranet.example.com' ? ['10.1.2.3'] : ['93.184.216.34']),
  );
  const signal = AbortSignal.timeout(5000);
  const five = await fetchPublicFile('https://five.example.com/0', signal);
  assert.equal(five.kind, 'file', 'five redirects are followed');
  assert.equal(five.url, 'https://five.example.com/0');
  const six = await fetchPublicFile('https://six.example.com/0', signal);
  assert.equal(six.reason, 'unavailable', 'a sixth redirect is not followed');
  assert.equal(
    web.requests.filter(request => request.host === 'six.example.com').length,
    6,
    'the target of the sixth redirect is never requested',
  );
  assert.equal(web.resolved.filter(name => name === 'five.example.com').length, 6, 'each hop is resolved and checked');
  for (const path of ['private', 'literal', 'plain'])
    assert.deepEqual(await fetchPublicFile(`https://start.example.com/${path}`, signal), {
      kind: 'failed',
      url: `https://start.example.com/${path}`,
      reason: 'not-public',
    });
  assert.equal(
    web.requests.some(request => request.host === 'intranet.example.com'),
    false,
    'a redirect to a private address is never connected',
  );
});

test('the connection uses the address that was checked, so DNS rebinding cannot reach a private address', async t => {
  const web = await localWeb(t, { 'rebind.example.com/file': send(200, png) }, (_hostname, call) =>
    call === 1 ? ['93.184.216.34'] : ['127.0.0.1'],
  );
  const file = await fetchPublicFile('https://rebind.example.com/file', AbortSignal.timeout(5000));
  assert.equal(file.kind, 'file');
  assert.deepEqual(web.resolved, ['rebind.example.com'], 'the name is resolved once, before the check');
  assert.deepEqual(web.connected, [{ hostname: 'rebind.example.com', address: '93.184.216.34' }]);
});

test('the production agent connects only through the pinned lookup', async t => {
  const server = createServer((_request, response) => response.end('pinned'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  // The name does not exist in DNS, so reaching the server proves the connection used the pinned address.
  const dispatcher = publicNetwork.dispatcher(pinnedLookup('pinned.invalid', ['127.0.0.1']));
  t.after(() => dispatcher.destroy());
  const response = await request(`http://pinned.invalid:${port}/`, { dispatcher });
  assert.equal(await response.body.text(), 'pinned');
  await assert.rejects(request(`http://other.invalid:${port}/`, { dispatcher }), /web-address-denied|ENOTFOUND/);
});

test('a body past 10 MiB is too large, whether declared or streamed', async t => {
  const chunk = Buffer.alloc(1024 * 1024, 7);
  await localWeb(t, {
    'big.example.com/declared': send(200, '', { 'content-length': String(publicFileLimits.maxBytes + 1) }),
    'big.example.com/streamed': (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let index = 0; index < 11; index++) response.write(chunk);
      response.end();
    },
    'big.example.com/exact': (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let index = 0; index < 10; index++) response.write(chunk);
      response.end();
    },
  });
  const signal = AbortSignal.timeout(10_000);
  assert.equal((await fetchPublicFile('https://big.example.com/declared', signal)).reason, 'too-large');
  assert.equal((await fetchPublicFile('https://big.example.com/streamed', signal)).reason, 'too-large');
  const exact = await fetchPublicFile('https://big.example.com/exact', signal);
  assert.equal(exact.kind, 'file');
  assert.equal(exact.bytes.byteLength, publicFileLimits.maxBytes);
});

test('a slow link times out at the deadline, and the caller can still abort', async t => {
  await localWeb(t, {
    'slow.example.com/file': (_request, response) => {
      response.writeHead(200);
      response.write(png.subarray(0, 8));
    },
  });
  const limits = { ...publicFileLimits };
  t.after(() => Object.assign(publicFileLimits, limits));
  publicFileLimits.deadlineMs = 200;
  const started = Date.now();
  const late = await fetchPublicFile('https://slow.example.com/file', AbortSignal.timeout(10_000));
  assert.deepEqual(late, { kind: 'failed', url: 'https://slow.example.com/file', reason: 'timed-out' });
  assert.ok(Date.now() - started < 5000);
  publicFileLimits.deadlineMs = 10_000;
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('turn-aborted')), 100);
  await assert.rejects(fetchPublicFile('https://slow.example.com/file', controller.signal), /turn-aborted/);
});

test('non-public links and web access off are refused without a request', async t => {
  const web = await localWeb(t, {});
  const signal = AbortSignal.timeout(5000);
  for (const url of ['http://example.com/a', 'https://127.0.0.1/a', 'https://example.com:8443/a', 'https://x.local/a'])
    assert.equal((await fetchPublicFile(url, signal)).reason, 'not-public');
  delete process.env.FIRECRAWL_ENDPOINT;
  assert.deepEqual(await fetchPublicFile('https://example.com/a', signal), {
    kind: 'failed',
    url: 'https://example.com/a',
    reason: 'web-off',
  });
  assert.deepEqual(web.resolved, []);
  assert.deepEqual(web.requests, []);
});
