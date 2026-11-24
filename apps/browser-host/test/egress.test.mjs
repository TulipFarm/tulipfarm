import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { startEgressProxy } from '../src/egress.ts';

const resolve = async host =>
  ({ 'site.test': ['127.0.0.1'], 'private.test': ['10.0.0.1'], 'mixed.test': ['127.0.0.1', '10.0.0.1'] })[host] ?? [];
const allowed = address => address === '127.0.0.1';

function viaProxy(proxy, options) {
  const { port } = new URL(proxy.server);
  return new Promise((done, fail) => {
    const sent = request({ host: '127.0.0.1', port, ...options }, done).on('connect', (response, socket) => {
      socket.destroy();
      done(response);
    });
    sent.on('error', fail);
    sent.end();
  });
}

test('the egress proxy opens only allowed addresses, for plain requests and tunnels', async t => {
  const site = createServer((incoming, response) => response.end(`host ${incoming.headers.host}`));
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const port = site.address().port;
  const proxy = await startEgressProxy({ allowed, resolve });
  t.after(async () => {
    site.close();
    await proxy.close();
  });

  const reached = await viaProxy(proxy, { path: `http://site.test:${port}/`, headers: { host: `site.test:${port}` } });
  assert.equal(reached.statusCode, 200);
  let body = '';
  for await (const chunk of reached) body += chunk;
  assert.equal(body, `host site.test:${port}`);

  for (const host of ['private.test', 'mixed.test', 'missing.test', '[::1]']) {
    const refused = await viaProxy(proxy, { path: `http://${host}:${port}/` });
    assert.equal(refused.statusCode, 403, host);
    refused.resume();
  }
  const tunnel = await viaProxy(proxy, { method: 'CONNECT', path: `site.test:${port}` });
  assert.equal(tunnel.statusCode, 200);
  const blocked = await viaProxy(proxy, { method: 'CONNECT', path: `private.test:443` });
  assert.equal(blocked.statusCode, 403);
});
