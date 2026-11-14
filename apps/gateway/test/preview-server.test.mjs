/* oxlint-disable tulipfarm/product-copy -- Hostnames, header values and protocol payloads, not application copy. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { AppHostUnavailableError } from '@tulipfarm/extensions';
import { buildGateway } from '../src/gateway.ts';

const key = 'abcdefghijklmnopqrstuvwxyz';
const host = `${key}.preview.tulipfarm.test`;
const origin = `http://${host}`;
const shellOrigin = 'https://app.tulipfarm.test';
const appId = '22222222-2222-4222-8222-222222222222';
const session = { workspaceId: '11111111-1111-4111-8111-111111111111', appId, membershipId: 'm' };
const cookie = '__Host-tf_preview=token-1; theme=dark';
const policyClose = Buffer.from([0x88, 0x02, 0x03, 0xf0]);
const draftCookies = [
  'cart=3; Path=/; Secure',
  '__Host-tf_session=forged; Path=/; Secure',
  '__host-TF_preview=forged; Path=/; Secure',
  'wide=1; Domain=preview.tulipfarm.test; Path=/',
];
const cookieLines = draftCookies.map(line => `Set-Cookie: ${line}\r\n`).join('');

/** Stands in for the forwarding layer in front of the draft's host: it answers only for the host it was given. */
async function draftServer(t) {
  const state = { requests: 0, seen: [], streams: 0, sockets: 0 };
  const server = createServer(async (incoming, response) => {
    state.requests += 1;
    state.seen.push(incoming.headers);
    if (incoming.headers['x-spawnbox-target'] !== 'host-1')
      return response.writeHead(403, { 'X-Spawnbox-Error': 'forbidden' }).end();
    if (incoming.url === '/events') {
      state.streams += 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ticker = setInterval(() => response.write('data: tick\n\n'), 20);
      response.on('close', () => clearInterval(ticker));
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    response
      .writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Security-Policy': "default-src 'self'",
        'Cache-Control': 'public, max-age=3600',
        'Set-Cookie': draftCookies,
      })
      .end(
        JSON.stringify({ method: incoming.method, url: incoming.url, body: Buffer.concat(chunks).toString('utf8') }),
      );
  });
  // A WebSocket server that accepts the handshake and keeps the socket open, except on /refused.
  server.on('upgrade', (incoming, socket) => {
    state.sockets += 1;
    state.seen.push(incoming.headers);
    if (incoming.url === '/refused')
      return socket.end(`HTTP/1.1 403 Forbidden\r\n${cookieLines}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    const accept = createHash('sha1')
      .update(`${incoming.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.on('error', () => socket.destroy());
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${cookieLines}\r\n`,
    );
    socket.on('end', () => socket.end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return { state, url: `http://127.0.0.1:${server.address().port}/` };
}

async function previewFor(t, options = {}) {
  const upstream = await draftServer(t);
  const access = { role: 'edit', hostRef: 'host-1', app: true, enabled: true, failing: false };
  const calls = { targets: 0, connects: 0 };
  const gateway = buildGateway({
    preview: {
      domain: 'preview.tulipfarm.test',
      shellOrigin,
      redeem: async () => null,
      session: async (previewKey, token) => (previewKey === key && token === 'token-1' ? session : null),
      enabled: async () => access.enabled,
      async target() {
        calls.targets += 1;
        if (access.failing) throw new Error('connect ECONNREFUSED');
        if (!access.app) return { ok: false, failure: { code: 'not-found', message: 'App not found' } };
        if (access.role !== 'edit') return { ok: false, failure: { code: 'forbidden', message: 'Edit is required' } };
        return { ok: true, target: { kind: 'server', hostRef: access.hostRef } };
      },
      object: async () => null,
      async connectHost(input) {
        calls.connects += 1;
        if (options.hostless) throw new AppHostUnavailableError();
        assert.deepEqual(input, { appId, hostRef: 'host-1' });
        return { url: upstream.url, headers: { 'X-Spawnbox-Target': input.hostRef } };
      },
      recheckMs: options.recheckMs ?? 100,
    },
    apps: null,
    serverOptions: {},
    identity: { version: 'development', commit: 'development' },
  });
  await gateway.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => gateway.close());
  return { port: gateway.server.address().port, upstream: upstream.state, access, calls };
}

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port, method, path, headers: { host, cookie, ...headers } },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

/** Opens a WebSocket by hand and resolves with the handshake status and headers, plus the socket once it switched. */
function connect(port, headers = {}, path = '/live') {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path,
      headers: Object.fromEntries(
        Object.entries({
          host,
          cookie,
          origin,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': randomBytes(16).toString('base64'),
          'sec-websocket-version': '13',
          ...headers,
        }).filter(([, value]) => value !== undefined),
      ),
    });
    outgoing.on('response', response => {
      response.resume();
      resolve({ status: response.statusCode, headers: response.headers });
    });
    outgoing.on('upgrade', (response, socket) =>
      resolve({ status: response.statusCode, headers: response.headers, socket }),
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** Resolves with everything the socket received once it is closed. */
function closed(socket) {
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  socket.on('error', () => {});
  return new Promise(resolve => socket.on('close', () => resolve(Buffer.concat(chunks))));
}

test("an editor's draft request reaches the draft's server", async t => {
  const { port, upstream, calls } = await previewFor(t);

  const response = await call(port, { method: 'POST', path: '/orders?x=1', headers: { origin }, body: 'item=tea' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { method: 'POST', url: '/orders?x=1', body: 'item=tea' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['content-security-policy'], `default-src 'self', frame-ancestors ${shellOrigin}`);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.deepEqual(response.headers['set-cookie'], ['cart=3; Path=/; Secure']);
  assert.equal(upstream.seen[0]['x-spawnbox-target'], 'host-1');
  assert.equal(upstream.seen[0].cookie, 'theme=dark');
  assert.equal(calls.targets, 1);
  assert.equal(calls.connects, 1);

  const socket = await connect(port);
  assert.equal(socket.status, 101);
  socket.socket.destroy();
  assert.equal(upstream.sockets, 1);
  assert.equal(upstream.seen[1].cookie, 'theme=dark');
});

test('a WebSocket handshake carries only the cookies a draft may set', async t => {
  const { port } = await previewFor(t);

  const switched = await connect(port);
  assert.equal(switched.status, 101);
  switched.socket.destroy();
  assert.deepEqual(switched.headers['set-cookie'], ['cart=3; Path=/; Secure']);

  const refused = await connect(port, {}, '/refused');
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.headers['set-cookie'], ['cart=3; Path=/; Secure']);
});

test('a request without a valid session never reaches the draft', async t => {
  const { port, upstream, calls } = await previewFor(t);

  assert.equal((await call(port, { headers: { cookie: '' } })).status, 401);
  assert.equal((await call(port, { headers: { cookie: '__Host-tf_preview=other' } })).status, 401);
  assert.equal((await connect(port, { cookie: '' })).status, 401);
  assert.equal(upstream.requests, 0);
  assert.equal(upstream.sockets, 0);
  assert.equal(calls.connects, 0);
});

test('another site cannot send unsafe requests or open WebSockets on the draft', async t => {
  const { port, upstream, calls } = await previewFor(t);

  const posted = await call(port, { method: 'POST', headers: { origin: 'https://evil.test' }, body: 'a=1' });
  assert.equal(posted.status, 403);
  assert.equal((await call(port, { method: 'DELETE' })).status, 403);
  assert.equal((await call(port, { method: 'PUT', headers: { origin: `https://${host}` } })).status, 403);
  assert.equal((await connect(port, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await connect(port, { origin: undefined })).status, 403);
  assert.equal(calls.targets, 0);
  assert.equal(upstream.requests, 0);
  assert.equal(upstream.sockets, 0);
});

test('the next request after access is lost is denied', async t => {
  const { port, upstream, access } = await previewFor(t);
  assert.equal((await call(port)).status, 200);

  access.role = 'use';
  const revoked = await call(port, { headers: { accept: 'text/html' } });
  assert.equal(revoked.status, 403);
  assert.match(revoked.body, /You can no longer edit this app/);
  assert.equal((await connect(port)).status, 403);

  access.role = 'edit';
  access.app = false;
  assert.equal((await call(port)).status, 404);

  access.app = true;
  access.enabled = false;
  assert.equal((await call(port)).status, 404);
  assert.equal(upstream.requests, 1);
  assert.equal(upstream.sockets, 0);
});

test('a failing access check denies the request', async t => {
  const { port, upstream, access, calls } = await previewFor(t);
  access.failing = true;

  const response = await call(port, { headers: { accept: 'text/html' } });
  assert.equal(response.status, 503);
  assert.match(response.body, /The draft could not be loaded/);
  assert.equal((await connect(port)).status, 503);
  assert.equal(calls.connects, 0);
  assert.equal(upstream.requests, 0);
  assert.equal(upstream.sockets, 0);
});

test('an open WebSocket closes with 1008 soon after edit access is revoked', async t => {
  const { port, access } = await previewFor(t, { recheckMs: 100 });
  const { status, socket } = await connect(port);
  assert.equal(status, 101);
  const received = closed(socket);

  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(socket.destroyed, false);
  const revokedAt = Date.now();
  access.role = 'use';
  const frames = await received;
  const elapsed = Date.now() - revokedAt;
  assert.deepEqual([...frames.subarray(-4)], [...policyClose]);
  assert.ok(elapsed < 1_000, `closed after ${elapsed} ms`);
});

test('an open WebSocket closes when the access check fails', async t => {
  const { port, access } = await previewFor(t, { recheckMs: 100 });
  const { socket } = await connect(port);
  const received = closed(socket);
  access.failing = true;
  assert.deepEqual([...(await received).subarray(-4)], [...policyClose]);
});

test('a streamed response ends soon after the session loses access', async t => {
  const { port, upstream, access } = await previewFor(t, { recheckMs: 100 });
  const ended = new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path: '/events', headers: { host, cookie } }, response => {
      let ticks = 0;
      response.on('data', chunk => {
        ticks += chunk.toString().split('data: tick').length - 1;
        if (ticks === 5) {
          access.role = 'use';
          response.revokedAt = Date.now();
        }
      });
      response.on('error', () => {});
      response.on('close', () => resolve({ status: response.statusCode, elapsed: Date.now() - response.revokedAt }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
  const { status, elapsed } = await ended;
  assert.equal(status, 200);
  assert.equal(upstream.streams, 1);
  assert.ok(elapsed < 1_000, `ended after ${elapsed} ms`);
});

test('a draft whose server is not running says so without contacting a host', async t => {
  const { port, upstream, access, calls } = await previewFor(t);
  access.hostRef = null;

  const response = await call(port, { headers: { accept: 'text/html' } });
  assert.equal(response.status, 503);
  assert.match(response.body, /The server for this draft is not running\. Publish the app to run it\./);
  assert.match(response.headers['content-security-policy'], /frame-ancestors https:\/\/app\.tulipfarm\.test$/);
  assert.equal((await connect(port)).status, 503);
  assert.equal(calls.connects, 0);
  assert.equal(upstream.requests, 0);
});

test('a draft cannot install a service worker', async t => {
  const { port, upstream, calls } = await previewFor(t);
  const response = await call(port, { path: '/sw.js', headers: { 'service-worker': 'script' } });
  assert.equal(response.status, 403);
  assert.equal(calls.targets, 0);
  assert.equal(upstream.requests, 0);
});

test('without a way to reach a draft host the preview is unavailable', async t => {
  const { port, upstream } = await previewFor(t, { hostless: true });
  assert.equal((await call(port)).status, 503);
  assert.equal((await connect(port)).status, 503);
  assert.equal(upstream.requests, 0);
});
