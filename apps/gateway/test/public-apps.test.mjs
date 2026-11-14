/* oxlint-disable tulipfarm/product-copy -- Hostnames, header values and protocol payloads, not application copy. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { AppHostUnavailableError } from '@tulipfarm/extensions';
import { buildGateway } from '../src/gateway.ts';
import { appCookies } from '../src/forward.ts';
import { appNameOf, buildPublicAppsGateway } from '../src/public-apps.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const appId = '22222222-2222-4222-8222-222222222222';
const host = 'acme-api.apps.tulipfarm.test';
const browser = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

/**
 * Stands in for the forwarding layer in front of a sandbox: it checks the key and target the gateway was given,
 * wakes a stopped sandbox for any request that allows it, and answers with what the app received.
 */
async function sandbox(t, options = {}) {
  const state = { running: options.running === true, wakes: 0, requests: 0, keys: new Set(['key-1']), seen: [] };
  const refuse = (response, code, status = 503) =>
    response.writeHead(status, { 'X-Spawnbox-Error': code, 'Retry-After': '1' }).end();
  async function admit(incoming) {
    state.requests += 1;
    state.seen.push(incoming.headers);
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
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    response
      .writeHead(201, { 'Content-Type': 'application/json', 'X-App': 'menu', 'X-Spawnbox-Route': 'internal' })
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
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('end', () => socket.end());
    socket.on('data', frame => {
      if ((frame[0] & 0x0f) !== 1) return socket.end();
      const length = frame[1] & 0x7f;
      const mask = frame.subarray(2, 6);
      const payload = Buffer.from(frame.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4]));
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]));
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
      build: async () => ({ ok: true, build: null }),
      object: async () => null,
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
            headers: { 'X-Spawnbox-Key': `key-${calls.connects}`, 'X-Spawnbox-Target': appId },
          };
        },
      },
      wakeBudgetMs: 1_500,
    },
    serverOptions: {},
    identity: { version: 'development', commit: 'development' },
  });
  await gateway.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => gateway.close());
  return { port: gateway.server.address().port, upstream: upstream.state, calls };
}

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

async function until(condition) {
  while (!condition()) await new Promise(resolve => setTimeout(resolve, 10));
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
function echo(port, text) {
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
        resolve({ status: response.statusCode, text: frame.subarray(2, 2 + frame[1]).toString() });
      });
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('a WebSocket reaches the app and echoes', async t => {
  const { port, upstream } = await gatewayFor(t);
  assert.deepEqual(await echo(port, 'ping'), { status: 101, text: 'ping' });
  assert.equal(upstream.wakes, 1);
  assert.equal(upstream.seen[0]['x-spawnbox-target'], appId);
  assert.equal(upstream.seen[0].cookie, undefined);
});

test('names that lead nowhere get 404, stopped apps and a missing host get 503', async t => {
  await t.test('the workspace has app hosting off', async t => {
    const { port, upstream } = await gatewayFor(t, { enabled: false });
    const response = await call(port, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 404);
    assert.match(response.body, /There is nothing here/);
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
    assert.match(response.body, /This app is unavailable/);
    assert.equal(calls.connects, 0);
  });
  await t.test('no app host is registered', async t => {
    const { port } = await gatewayFor(t, { hostless: true });
    const response = await call(port);
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: 'app-unavailable' });
  });
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
