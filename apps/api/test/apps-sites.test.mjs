import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { routeAppSites } from '../src/apps-sites.ts';

test('app site hosts are answered by the publisher before any shell route', async t => {
  const served = [];
  const publisher = {
    async serve(request) {
      served.push(request);
      if (request.host === 'paused.apps.example.test') return { kind: 'unavailable' };
      if (request.path !== '/index.html') return { kind: 'not-found' };
      return {
        kind: 'file',
        object: {
          contentType: 'text/html; charset=utf-8',
          bytes: 15,
          body: (async function* () {
            yield Buffer.from('<h1>Orders</h1>');
          })(),
        },
      };
    },
  };
  const app = Fastify();
  routeAppSites(app, { publisher, domain: 'apps.example.test', excluded: 'drafts.apps.example.test' });
  app.get('/index.html', async () => 'shell');
  t.after(() => app.close());

  const site = await app.inject({ url: '/index.html?v=1', headers: { host: 'orders.apps.example.test:443' } });
  assert.equal(site.statusCode, 200);
  assert.equal(site.body, '<h1>Orders</h1>');
  assert.equal(site.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(site.headers['cache-control'], 'public, max-age=60');
  assert.equal(site.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(served[0], { host: 'orders.apps.example.test', path: '/index.html' });

  const missing = await app.inject({ url: '/nope', headers: { host: 'orders.apps.example.test' } });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ url: '/', headers: { host: 'paused.apps.example.test' } })).statusCode, 503);
  const posted = await app.inject({
    method: 'POST',
    url: '/index.html',
    headers: { host: 'orders.apps.example.test' },
  });
  assert.equal(posted.statusCode, 405);
  assert.equal(posted.headers.allow, 'GET, HEAD');

  assert.equal(
    (await app.inject({ url: '/index.html', headers: { host: 'k1.drafts.apps.example.test' } })).body,
    'shell',
  );
  assert.equal((await app.inject({ url: '/index.html', headers: { host: 'localhost:3000' } })).body, 'shell');
  assert.equal(served.length, 3);
});

test('a HEAD request releases the stored file body without reading it', async t => {
  let destroyed = false;
  let read = false;
  const publisher = {
    async serve() {
      const body = new Readable({
        read() {
          read = true;
          this.push(Buffer.from('<h1>Orders</h1>'));
          this.push(null);
        },
        destroy(error, callback) {
          destroyed = true;
          callback(error);
        },
      });
      return { kind: 'file', object: { contentType: 'text/html; charset=utf-8', bytes: 15, body } };
    },
  };
  const app = Fastify();
  routeAppSites(app, { publisher, domain: 'apps.example.test' });
  t.after(() => app.close());

  const head = await app.inject({ method: 'HEAD', url: '/index.html', headers: { host: 'orders.apps.example.test' } });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-length'], '15');
  assert.equal(head.body, '');
  assert.equal(read, false);
  assert.equal(destroyed, true);
});
