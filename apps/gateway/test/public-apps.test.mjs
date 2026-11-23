/* oxlint-disable tulipfarm/product-copy -- Hostnames, header values and protocol payloads, not application copy. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { AppHostUnavailableError } from '@tulipfarm/extensions';
import { buildGateway } from '../src/gateway.ts';
import { appCookies } from '../src/forward.ts';
import { gatewayServerOptions } from '../src/http.ts';
import { appNameOf, buildPublicAppsGateway } from '../src/public-apps.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const appId = '22222222-2222-4222-8222-222222222222';
const releaseId = '44444444-4444-4444-8444-444444444444';
const host = 'acme-api.apps.tulipfarm.test';
const browser = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

/**
 * Stands in for the forwarding layer in front of a sandbox: it checks the key and target the gateway was given,
 * wakes a stopped sandbox for any request that allows it, and answers with what the app received.
 */
async function sandbox(t, options = {}) {
  const state = {
    running: options.running === true,
    wakes: 0,
    requests: 0,
    keys: new Set(['key-1']),
    seen: [],
    live: [],
  };
  const refuse = (response, code, status = 503) =>
    response.writeHead(status, { 'X-Spawnbox-Error': code, 'Retry-After': '1' }).end();
  async function admit(incoming) {
    state.requests += 1;
    state.seen.push(incoming.headers);
    state.live.push(options.live?.resolve(incoming.headers['tulipfarm-request']) ?? null);
    if (!state.keys.has(incoming.headers['x-spawnbox-key'])) return 'unauthorized';
    if (incoming.headers['x-spawnbox-target'] !== appId) return 'forbidden';
    if (state.running) return null;
    if (incoming.headers['x-spawnbox-wake'] === 'never') return 'sandbox_paused';
    if (options.neverReady) return 'not_ready';
    state.wakes += 1;
    await new Promise(resolve => setTimeout(resolve, 200));
    state.running = true;
    return null;
  }
  const server = createServer(async (incoming, response) => {
    const refused = await admit(incoming);
    if (refused) return refuse(response, refused, refused === 'unauthorized' ? 401 : 503);
    if (incoming.url === '/slow') await new Promise(resolve => setTimeout(resolve, 3_000));
    if (incoming.url === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ticker = setInterval(() => response.write('data: tick\n\n'), 20);
      response.on('close', () => clearInterval(ticker));
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    response
      .writeHead(201, {
        'Content-Type': 'application/json',
        'X-App': 'menu',
        'X-Spawnbox-Route': 'internal',
        'tulipfarm-request': 'tfr_echoed',
        'TulipFarm-Anything': 'leaked',
      })
      .end(
        JSON.stringify({ method: incoming.method, url: incoming.url, body: Buffer.concat(chunks).toString('utf8') }),
      );
  });
  // A WebSocket server that echoes each short text frame.
  server.on('upgrade', async (incoming, socket) => {
    const refused = await admit(incoming);
    if (refused) return socket.end(`HTTP/1.1 503 Service Unavailable\r\nX-Spawnbox-Error: ${refused}\r\n\r\n`);
    const accept = createHash('sha1')
      .update(`${incoming.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-App: live\r\ntulipfarm-request: tfr_echoed\r\nTulipFarm-Anything: leaked\r\n\r\n`,
    );
    socket.on('end', () => socket.end());
    socket.on('data', async frame => {
      if ((frame[0] & 0x0f) !== 1) return socket.end();
      const length = frame[1] & 0x7f;
      const mask = frame.subarray(2, 6);
      const payload = Buffer.from(frame.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4]));
      const reply = Buffer.concat([Buffer.from([0x81, length]), payload]);
      // `slow` arrives in two writes with a pause inside the frame.
      if (payload.toString() !== 'slow') return socket.write(reply);
      socket.write(reply.subarray(0, 4));
      await new Promise(resolve => setTimeout(resolve, 300));
      socket.write(reply.subarray(4));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { state, url: `http://127.0.0.1:${server.address().port}/` };
}

async function gatewayFor(t, options = {}) {
  const upstream = await sandbox(t, options);
  const calls = { connects: 0, routes: 0 };
  const route = options.route ?? { name: 'acme-api', kind: 'server', status: 'active', version: 3 };
  const gateway = buildGateway({
    preview: {
      domain: 'preview.tulipfarm.test',
      shellOrigin: 'https://app.tulipfarm.test',
      redeem: async () => null,
      session: async () => null,
      enabled: async () => true,
      target: async () => ({ ok: true, target: { kind: 'files', build: null } }),
      object: async () => null,
      connectHost: async () => {
        throw new AppHostUnavailableError();
      },
    },
    apps: {
      domain: 'apps.tulipfarm.test',
      async route(name) {
        calls.routes += 1;
        return name === 'acme-api' ? { workspaceId, appId, route } : null;
      },
      enabled: async id => id === workspaceId && options.enabled !== false,
      host: {
        async connect(input) {
          calls.connects += 1;
          assert.deepEqual(input, { appId });
          if (options.hostless) throw new AppHostUnavailableError();
          return {
            url: upstream.url,
            headers: {
              'X-Spawnbox-Key': `key-${calls.connects}`,
              'X-Spawnbox-Target': appId,
              ...options.endpointHeaders,
            },
          };
        },
      },
      wakeBudgetMs: 1_500,
      keepaliveMs: options.keepaliveMs,
      liveRequests: options.live && {
        store: options.live.store,
        renewMs: options.live.renewMs,
        sweepMs: options.live.sweepMs,
      },
    },
    serverOptions: options.serverOptions ?? {},
    identity: { version: 'development', commit: 'development' },
  });
  await gateway.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => gateway.close());
  return { port: gateway.server.address().port, upstream: upstream.state, calls };
}

/**
 * Stands in for the live request store, keeping handles in memory: each expires `ttlMs` after it was minted or last
 * renewed, as the database's would after a minute.
 */
function liveStore(options = {}) {
  const ttlMs = options.ttlMs ?? 60_000;
  const open = new Map();
  const state = {
    release: options.release === undefined ? releaseId : options.release,
    mints: 0,
    renews: 0,
    failing: false,
    held: null,
    reads: 0,
  };
  const resolve = handle => {
    const found = open.get(handle);
    return found !== undefined && found.until > Date.now() ? found.request : null;
  };
  const store = {
    async dataRelease(app) {
      assert.deepEqual(app, { workspaceId, appId });
      state.reads += 1;
      await state.held;
      return state.release;
    },
    async mint(request) {
      if (state.failing) throw new Error('connect ECONNREFUSED');
      state.mints += 1;
      const handle = `tfr_${randomBytes(32).toString('base64url')}`;
      open.set(handle, { request, until: Date.now() + ttlMs });
      return handle;
    },
    async renew(handle) {
      state.renews += 1;
      if (!resolve(handle)) return false;
      open.get(handle).until = Date.now() + ttlMs;
      return true;
    },
    async close(handle) {
      open.delete(handle);
    },
    async sweep() {
      const expired = [...open].filter(([, found]) => found.until <= Date.now());
      for (const [handle] of expired) open.delete(handle);
      return expired.length;
    },
  };
  return { store, state, open, resolve, renewMs: options.renewMs, sweepMs: options.sweepMs };
}

const served = { workspaceId, appId, releaseId };

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }),
      );
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('public app hosts are recognised by a valid app name', () => {
  assert.equal(appNameOf('Acme-API.Apps.TulipFarm.test:443', 'apps.tulipfarm.test'), 'acme-api');
  assert.equal(appNameOf('acme-api.apps.tulipfarm.test.', 'apps.tulipfarm.test'), 'acme-api');
  assert.equal(appNameOf('a.b.apps.tulipfarm.test', 'apps.tulipfarm.test'), null);
  assert.equal(appNameOf('api.tulipfarm.test', 'apps.tulipfarm.test'), undefined);
});

test('only TulipFarm cookies are taken out', () => {
  assert.equal(appCookies('__Host-tf_session=s; theme=dark; __Host-tf_preview=p; cart=3'), 'theme=dark; cart=3');
  assert.equal(appCookies('__Host-tf_session=s'), undefined);
  assert.equal(appCookies(undefined), undefined);
});

test('a burst of requests to a stopped app wakes it once', async t => {
  const { port, upstream, calls } = await gatewayFor(t);
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) => call(port, { path: `/orders?page=${index}` })),
  );
  assert.deepEqual(
    responses.map(response => response.status),
    Array.from({ length: 20 }, () => 201),
  );
  assert.deepEqual(JSON.parse(responses[7].body), { method: 'GET', url: '/orders?page=7', body: '' });
  assert.equal(calls.connects, 1);
  assert.equal(calls.routes, 1);
  assert.equal(upstream.wakes, 1);
  assert.equal(upstream.requests, 20);
});

/** Starts a POST whose body arrives in two parts; `finish` sends the rest and resolves with the response. */
function trickle(port) {
  let settled = false;
  const outgoing = request({ host: '127.0.0.1', port, method: 'POST', path: '/orders', headers: { host } });
  const response = new Promise((resolve, reject) => {
    outgoing.on('response', incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => {
        settled = true;
        resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() });
      });
    });
    outgoing.on('error', reject);
  });
  outgoing.write('{"item":');
  return {
    settled: () => settled,
    abandon() {
      response.catch(() => {});
      outgoing.destroy();
    },
    finish() {
      outgoing.end('"tea"}');
      return response;
    },
  };
}

async function until(condition, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'the condition held in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a POST whose body is still arriving does not hold back other requests', async t => {
  for (const warmFirst of [false, true]) {
    await t.test(warmFirst ? 'the app answered a moment ago' : 'the app runs but has not answered lately', async t => {
      const { port, upstream } = await gatewayFor(t, { running: true });
      if (warmFirst) assert.equal((await call(port)).status, 201);
      const sent = upstream.requests;
      const post = trickle(port);
      try {
        await until(() => upstream.requests === sent + 1);
        const responses = await Promise.all(Array.from({ length: 5 }, () => call(port, { path: '/menu' })));
        assert.deepEqual(
          responses.map(response => response.status),
          [201, 201, 201, 201, 201],
        );
        assert.equal(post.settled(), false);
      } catch (error) {
        post.abandon();
        throw error;
      }
      const posted = await post.finish();
      assert.equal(posted.status, 201);
      assert.deepEqual(JSON.parse(posted.body), { method: 'POST', url: '/orders', body: '{"item":"tea"}' });
    });
  }
});

test('a slow request to a running app does not leave the others starting', async t => {
  const { port, upstream } = await gatewayFor(t, { running: true });
  const finished = [];
  const slow = call(port, { path: '/slow' }).then(response => (finished.push('/slow'), response));
  await until(() => upstream.requests === 1);
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => call(port, { path: '/menu' }).then(response => (finished.push('/menu'), response))),
  );
  assert.deepEqual(
    responses.map(response => response.status),
    [201, 201, 201, 201, 201],
  );
  assert.equal((await slow).status, 201);
  assert.deepEqual(finished, ['/menu', '/menu', '/menu', '/menu', '/menu', '/slow']);
  assert.equal(upstream.wakes, 0);
});

test('the client cannot steer the forwarding layer, and TulipFarm cookies and headers stay behind', async t => {
  const { port, upstream } = await gatewayFor(t);
  const response = await call(port, {
    method: 'POST',
    path: '/orders',
    headers: {
      'content-type': 'application/json',
      cookie: '__Host-tf_session=secret; theme=dark; __Host-tf_preview=token',
      'x-spawnbox-target': '33333333-3333-4333-8333-333333333333',
      'x-spawnbox-key': 'forged',
      'x-spawnbox-wake': 'never',
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-host': 'evil.test',
      'user-agent': browser,
    },
    body: '{"item":"tea"}',
  });
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(response.body), { method: 'POST', url: '/orders', body: '{"item":"tea"}' });
  assert.equal(response.headers['x-app'], 'menu');
  assert.equal(response.headers['x-spawnbox-route'], undefined);
  const [seen] = upstream.seen;
  assert.equal(seen['x-spawnbox-target'], appId);
  assert.equal(seen['x-spawnbox-key'], 'key-1');
  assert.equal(seen['x-spawnbox-wake'], undefined);
  assert.equal(seen.cookie, 'theme=dark');
  assert.equal(seen['x-forwarded-for'], '127.0.0.1');
  assert.equal(seen['x-forwarded-host'], host);
  assert.equal(seen['x-forwarded-proto'], 'http');
});

test('TulipFarm- headers are taken out on the way to the app and on the way back, over HTTP and WebSocket', async t => {
  const { port, upstream } = await gatewayFor(t, { running: true });
  const headers = { 'TulipFarm-Request': 'tfr_forged', 'TULIPFARM-anything': 'forged', 'x-visitor': 'kept' };
  const named = (seen, pattern) => Object.fromEntries(Object.entries(seen).filter(([name]) => pattern.test(name)));
  const http = await call(port, { headers });
  const socket = await echo(port, 'ping', headers);
  assert.deepEqual(
    upstream.seen.map(seen => named(seen, /^(tulipfarm-|x-visitor$)/)),
    [{ 'x-visitor': 'kept' }, { 'x-visitor': 'kept' }],
  );
  assert.deepEqual(named(http.headers, /^(tulipfarm-|x-app$)/), { 'x-app': 'menu' });
  assert.deepEqual(named(socket.headers, /^(tulipfarm-|x-app$)/), { 'x-app': 'live' });
});

test('HEAD requests and bots do not wake a stopped app', async t => {
  const { port, upstream } = await gatewayFor(t);
  const head = await call(port, { method: 'HEAD' });
  assert.equal(head.status, 503);
  assert.equal(head.headers['retry-after'], '1');
  const bot = await call(port, { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0', accept: 'text/html' } });
  assert.equal(bot.status, 503);
  assert.match(bot.body, /This app is asleep/);
  assert.equal(upstream.wakes, 0);
  assert.deepEqual(
    upstream.seen.map(headers => headers['x-spawnbox-wake']),
    ['never', 'never'],
  );
});

test('an app that does not start in time gets a starting page for browsers and JSON for other clients', async t => {
  const { port } = await gatewayFor(t, { neverReady: true });
  const page = await call(port, { headers: { accept: 'text/html', 'user-agent': browser } });
  assert.equal(page.status, 503);
  assert.equal(page.headers['retry-after'], '1');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.body, /<meta http-equiv="refresh" content="1">/);
  assert.match(page.body, /This app is starting/);
  const json = await call(port, { headers: { accept: 'application/json' } });
  assert.equal(json.status, 503);
  assert.deepEqual(JSON.parse(json.body), { error: 'app-starting' });
});

test('a stale endpoint is replaced once and the request sent again', async t => {
  const { port, upstream, calls } = await gatewayFor(t);
  upstream.keys = new Set(['key-2']);
  assert.equal((await call(port)).status, 201);
  assert.equal(calls.connects, 2);
  upstream.keys = new Set();
  assert.equal((await call(port)).status, 503);
  assert.equal(calls.connects, 3);
});

/** Opens a WebSocket by hand, since a browser-style client cannot name the app's host, and sends one text frame. */
function echo(port, text, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path: '/live',
      headers: {
        ...headers,
        host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        cookie: '__Host-tf_session=secret',
      },
    });
    outgoing.on('response', response => reject(new Error(`Upgrade refused with ${response.statusCode}`)));
    outgoing.on('upgrade', (response, socket) => {
      const mask = randomBytes(4);
      const payload = Buffer.from(text).map((byte, index) => byte ^ mask[index % 4]);
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload]));
      socket.once('data', frame => {
        socket.destroy();
        resolve({
          status: response.statusCode,
          text: frame.subarray(2, 2 + frame[1]).toString(),
          headers: response.headers,
        });
      });
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('a WebSocket reaches the app and echoes', async t => {
  const { port, upstream } = await gatewayFor(t);
  const { status, text } = await echo(port, 'ping');
  assert.deepEqual({ status, text }, { status: 101, text: 'ping' });
  assert.equal(upstream.wakes, 1);
  assert.equal(upstream.seen[0]['x-spawnbox-target'], appId);
  assert.equal(upstream.seen[0].cookie, undefined);
});

/** Opens a WebSocket, optionally sends one text frame, and resolves with every byte the client received in `ms`. */
function listen(port, ms, text) {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path: '/live',
      headers: {
        host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
      },
    });
    outgoing.on('upgrade', (_response, socket) => {
      const chunks = [];
      socket.on('data', chunk => chunks.push(chunk));
      if (text !== undefined) {
        const mask = randomBytes(4);
        const payload = Buffer.from(text).map((byte, index) => byte ^ mask[index % 4]);
        socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload]));
      }
      setTimeout(() => {
        resolve({ bytes: Buffer.concat(chunks).toString('hex'), open: !socket.destroyed && socket.readable });
        socket.destroy();
      }, ms);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('an idle WebSocket gets a pong frame each keepalive interval and stays open', async t => {
  const { port } = await gatewayFor(t, { keepaliveMs: 100 });
  const { bytes, open } = await listen(port, 450);
  assert.equal(open, true);
  assert.match(bytes, /^(8a00){3,4}$/);
});

test('a keepalive frame never lands inside a frame the app is still sending', async t => {
  const { port } = await gatewayFor(t, { keepaliveMs: 100 });
  const { bytes } = await listen(port, 350, 'slow');
  assert.equal(bytes.replace(/^(8a00)+|(8a00)+$/g, ''), `8104${Buffer.from('slow').toString('hex')}`);
});

test('names that lead nowhere get 404, stopped apps and a missing host get 503', async t => {
  await t.test('the workspace has app hosting off', async t => {
    const { port, upstream } = await gatewayFor(t, { enabled: false });
    const response = await call(port, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 404);
    assert.match(response.body, /There is no app at this address/);
    assert.equal(upstream.requests, 0);
  });
  await t.test('no app holds the name', async t => {
    const { port } = await gatewayFor(t);
    const response = await call(port, { headers: { host: 'acme-web.apps.tulipfarm.test' } });
    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), { error: 'not-found' });
  });
  await t.test('the app serves released files', async t => {
    const { port } = await gatewayFor(t, {
      route: { name: 'acme-api', kind: 'static', releaseId: null, status: 'active', version: 3 },
    });
    assert.equal((await call(port)).status, 404);
  });
  await t.test('the app is paused', async t => {
    const { port, calls } = await gatewayFor(t, {
      route: { name: 'acme-api', kind: 'server', status: 'paused', version: 4 },
    });
    const response = await call(port, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 503);
    assert.match(response.body, /This app is not available right now/);
    assert.equal(calls.connects, 0);
  });
  await t.test('no app host is registered', async t => {
    const { port } = await gatewayFor(t, { hostless: true });
    const response = await call(port);
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: 'app-unavailable' });
  });
});

test('a static app is served from its live release', async t => {
  const files = { 'index.html': 'home', 'assets/app.js': 'code' };
  const read = [];
  const route = { name: 'acme-api', kind: 'static', releaseId, status: 'active', version: 4 };
  const { http } = buildPublicAppsGateway(
    {
      domain: 'apps.tulipfarm.test',
      route: async name => (name === 'acme-api' ? { workspaceId, appId, route } : null),
      enabled: async () => true,
      host: {},
      async files(release, path) {
        read.push([release, path]);
        const body = files[decodeURIComponent(path).slice(1) || 'index.html'];
        if (body === undefined) return null;
        return { body: [Buffer.from(body)], contentType: 'text/plain', bytes: body.length };
      },
    },
    {},
  );
  t.after(() => http.close());
  const home = await http.inject({ url: '/?q=1', headers: { host } });
  assert.equal(home.statusCode, 200);
  assert.equal(home.body, 'home');
  assert.equal(home.headers['cache-control'], 'public, max-age=60');
  assert.equal((await http.inject({ url: '/assets/app.js', headers: { host } })).body, 'code');
  assert.deepEqual(read, [
    [releaseId, '/'],
    [releaseId, '/assets/app.js'],
  ]);
  assert.equal((await http.inject({ url: '/missing.js', headers: { host } })).statusCode, 404);
  assert.equal((await http.inject({ method: 'POST', url: '/', headers: { host } })).statusCode, 405);
});

test('a static app is left to the edge when the gateway has no released files', async t => {
  const route = { name: 'acme-api', kind: 'static', releaseId, status: 'active', version: 4 };
  const { http } = buildPublicAppsGateway(
    {
      domain: 'apps.tulipfarm.test',
      route: async () => ({ workspaceId, appId, route }),
      enabled: async () => true,
      host: {},
    },
    {},
  );
  t.after(() => http.close());
  assert.equal((await http.inject({ url: '/', headers: { host } })).statusCode, 404);
});

test('one client is limited to 1,200 requests a minute', async t => {
  const { http } = buildPublicAppsGateway(
    { domain: 'apps.tulipfarm.test', route: async () => null, enabled: async () => true, host: {} },
    {},
  );
  t.after(() => http.close());
  const send = () => http.inject({ url: '/', headers: { host } });
  for (let sent = 0; sent < 1_200; sent += 1) assert.equal((await send()).statusCode, 404);
  const limited = await send();
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), { error: 'rate-limit-exceeded' });
});

/** What the load balancer sends when a client that forged its own hop reaches it through a CloudFront edge. */
const throughEdge = client => ({ 'x-forwarded-for': `198.51.100.66, ${client}, 192.0.2.10` });

test('behind CloudFront and a load balancer the client is the second forwarded hop', async t => {
  const proxied = mode => ({ serverOptions: gatewayServerOptions({ GATEWAY_PROXY_MODE: mode }) });
  for (const [mode, forwardedFor] of [
    ['cloudfront', '203.0.113.7'],
    ['reverse-proxy', '192.0.2.10'],
    ['direct', '127.0.0.1'],
  ]) {
    await t.test(mode, async t => {
      const { port, upstream } = await gatewayFor(t, { ...proxied(mode), running: true });
      assert.equal((await call(port, { headers: throughEdge('203.0.113.7') })).status, 201);
      const { status, text } = await echo(port, 'ping', throughEdge('203.0.113.7'));
      assert.deepEqual({ status, text }, { status: 101, text: 'ping' });
      assert.deepEqual(
        upstream.seen.map(seen => seen['x-forwarded-for']),
        [forwardedFor, forwardedFor],
      );
    });
  }
  assert.throws(() => gatewayServerOptions({ GATEWAY_PROXY_MODE: 'true' }));
});

test('the app sees only the forwarding headers the gateway derived, over HTTP and WebSocket', async t => {
  const forged = {
    'x-forwarded-host': 'evil.test',
    'x-forwarded-proto': 'https',
    forwarded: 'for=198.51.100.66;host=evil.test;proto=https',
    'x-real-ip': '198.51.100.66',
    'x-spawnbox-key': 'forged',
    'x-spawnbox-target': '33333333-3333-4333-8333-333333333333',
  };
  for (const [mode, headers, expected] of [
    ['cloudfront', { ...forged, ...throughEdge('203.0.113.7') }, { for: '203.0.113.7', host, proto: 'https' }],
    ['direct', { ...forged, 'x-forwarded-for': '203.0.113.7' }, { for: '127.0.0.1', host, proto: 'http' }],
  ]) {
    await t.test(mode, async t => {
      const { port, upstream } = await gatewayFor(t, {
        serverOptions: gatewayServerOptions({ GATEWAY_PROXY_MODE: mode }),
        running: true,
      });
      assert.equal((await call(port, { headers })).status, 201);
      const { status, text } = await echo(port, 'ping', headers);
      assert.deepEqual({ status, text }, { status: 101, text: 'ping' });
      const forwarding = seen =>
        Object.fromEntries(
          Object.entries(seen).filter(([name]) => /^(x-forwarded-|x-real-ip$|forwarded$|x-spawnbox-)/.test(name)),
        );
      const sent = {
        'x-forwarded-for': expected.for,
        'x-forwarded-host': expected.host,
        'x-forwarded-proto': expected.proto,
        'x-spawnbox-key': 'key-1',
        'x-spawnbox-target': appId,
      };
      assert.deepEqual(upstream.seen.map(forwarding), [sent, sent]);
    });
  }
});

test('two clients behind the same CloudFront edge have separate request limits', async t => {
  const { http } = buildPublicAppsGateway(
    { domain: 'apps.tulipfarm.test', route: async () => null, enabled: async () => true, host: {} },
    gatewayServerOptions({ GATEWAY_PROXY_MODE: 'cloudfront' }),
  );
  t.after(() => http.close());
  const send = client =>
    http.inject({ url: '/', remoteAddress: '10.0.1.5', headers: { host, ...throughEdge(client) } });
  for (let sent = 0; sent < 1_200; sent += 1) assert.equal((await send('203.0.113.7')).statusCode, 404);
  assert.equal((await send('203.0.113.7')).statusCode, 429);
  assert.equal((await send('203.0.113.8')).statusCode, 404);
});

test('two clients behind the same CloudFront edge have separate WebSocket limits', async t => {
  const { port } = await gatewayFor(t, { serverOptions: gatewayServerOptions({ GATEWAY_PROXY_MODE: 'cloudfront' }) });
  const open = client =>
    new Promise((resolve, reject) => {
      const headers = {
        host: 'acme-web.apps.tulipfarm.test',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        ...throughEdge(client),
      };
      const outgoing = request({ host: '127.0.0.1', port, headers, agent: false }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  for (let opened = 0; opened < 120; opened += 1) assert.equal(await open('203.0.113.7'), 404);
  assert.equal(await open('203.0.113.7'), 429);
  assert.equal(await open('203.0.113.8'), 404);
});

test('a visitor request to an app with data views carries a live handle until its response ends', async t => {
  const live = liveStore();
  const { port, upstream } = await gatewayFor(t, { running: true, live });
  const response = await call(port, { headers: { 'TulipFarm-Request': 'tfr_forged' } });
  assert.equal(response.status, 201);
  const handle = upstream.seen[0]['tulipfarm-request'];
  assert.match(handle, /^tfr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(upstream.live, [served]);
  assert.equal(response.headers['tulipfarm-request'], undefined);
  await until(() => live.resolve(handle) === null);
  assert.equal(live.open.size, 0);
});

test('a request sent again to a fresh endpoint keeps its one handle', async t => {
  const live = liveStore();
  const { port, upstream, calls } = await gatewayFor(t, { running: true, live });
  upstream.keys = new Set(['key-2']);
  assert.equal((await call(port)).status, 201);
  assert.equal(calls.connects, 2);
  const [first, second] = upstream.seen.map(seen => seen['tulipfarm-request']);
  assert.match(first, /^tfr_/);
  assert.equal(second, first);
  assert.equal(live.state.mints, 1);
  assert.deepEqual(upstream.live, [served, served]);
});

test('a stream stays live past the expiry while its client is connected, and ends when the client drops', async t => {
  const live = liveStore({ ttlMs: 150, renewMs: 40 });
  const { port, upstream } = await gatewayFor(t, { running: true, live });
  const outgoing = request({ host: '127.0.0.1', port, path: '/events', headers: { host } });
  outgoing.on('error', () => {});
  t.after(() => outgoing.destroy());
  const ticks = new Promise(resolve => {
    outgoing.on('response', response => {
      let received = '';
      response.on('data', chunk => {
        received += chunk;
        if (received.split('tick').length > 20) resolve(received);
      });
    });
  });
  outgoing.end();
  await ticks;
  const handle = upstream.seen[0]['tulipfarm-request'];
  assert.deepEqual(live.resolve(handle), served);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(live.resolve(handle), served);
  outgoing.destroy();
  await until(() => live.resolve(handle) === null);
  assert.equal(live.open.size, 0);
});

test('a WebSocket holds a handle until it closes', async t => {
  const live = liveStore();
  const { port, upstream } = await gatewayFor(t, { running: true, live });
  const { status, text } = await echo(port, 'ping', { 'TulipFarm-Request': 'tfr_forged' });
  assert.deepEqual({ status, text }, { status: 101, text: 'ping' });
  const handle = upstream.seen[0]['tulipfarm-request'];
  assert.match(handle, /^tfr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(upstream.live, [served]);
  await until(() => live.resolve(handle) === null);
  assert.equal(live.open.size, 0);
});

/** Holds the route lookup's data view read until `release` is called, so a client can leave while it is pending. */
function holdLookup(live) {
  let release;
  live.state.held = new Promise(resolve => (release = resolve));
  return () => {
    live.state.held = null;
    release();
  };
}

test('a visitor who leaves while the app is looked up leaves no live handle behind', async t => {
  await t.test('an HTTP request', async t => {
    const live = liveStore({ renewMs: 10 });
    const { port, upstream } = await gatewayFor(t, { running: true, live });
    const release = holdLookup(live);
    const outgoing = request({ host: '127.0.0.1', port, path: '/events', headers: { host } });
    outgoing.on('error', () => {});
    outgoing.end();
    await until(() => live.state.reads === 1);
    outgoing.destroy();
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(live.open.size, 0);
    assert.equal(live.state.renews, 0);
    assert.deepEqual(upstream.seen, []);
  });
  await t.test('a WebSocket upgrade', async t => {
    const live = liveStore({ renewMs: 10 });
    const { port, upstream } = await gatewayFor(t, { running: true, live });
    const release = holdLookup(live);
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path: '/live',
      headers: {
        host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
      },
    });
    outgoing.on('error', () => {});
    outgoing.end();
    await until(() => live.state.reads === 1);
    outgoing.destroy();
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(live.open.size, 0);
    assert.equal(live.state.renews, 0);
    assert.deepEqual(upstream.seen, []);
  });
});

test('apps without approved data views get no handle, and a failed mint relays without one', async t => {
  await t.test('no approved data view', async t => {
    const live = liveStore({ release: null });
    const { port, upstream } = await gatewayFor(t, { running: true, live });
    assert.equal((await call(port, { headers: { 'TulipFarm-Request': 'tfr_forged' } })).status, 201);
    assert.equal((await echo(port, 'ping')).text, 'ping');
    assert.deepEqual(
      upstream.seen.map(seen => seen['tulipfarm-request']),
      [undefined, undefined],
    );
    assert.equal(live.state.mints, 0);
  });
  await t.test('the store is down', async t => {
    const live = liveStore();
    live.state.failing = true;
    const { port, upstream } = await gatewayFor(t, { running: true, live });
    const response = await call(port, { headers: { 'TulipFarm-Request': 'tfr_forged' } });
    assert.equal(response.status, 201);
    assert.equal(upstream.seen[0]['tulipfarm-request'], undefined);
  });
});

test('an endpoint cannot set the request handle', async t => {
  const live = liveStore();
  const { port, upstream } = await gatewayFor(t, {
    running: true,
    live,
    endpointHeaders: { 'TulipFarm-Request': 'tfr_from_endpoint' },
  });
  assert.equal((await call(port)).status, 201);
  assert.deepEqual(upstream.live, [served]);
  assert.equal(live.state.mints, 1);
});

test('expired handles are swept on a timer', async t => {
  const live = liveStore({ sweepMs: 20 });
  await gatewayFor(t, { running: true, live });
  live.open.set('tfr_expired', { request: served, until: Date.now() - 1 });
  live.open.set('tfr_open', { request: served, until: Date.now() + 60_000 });
  await until(() => !live.open.has('tfr_expired'));
  assert.deepEqual([...live.open.keys()], ['tfr_open']);
});
