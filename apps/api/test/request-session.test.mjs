import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { authenticateRoutes, protectExpectedSession } from '../src/authenticated-routes.ts';
import { requestSession } from '../src/request-session.ts';

test('a request reads its sign-in session once across hooks and handler', async () => {
  let reads = 0;
  const auth = {
    api: {
      getSession: async () => {
        reads++;
        return { user: { id: 'reader' }, session: { id: 'current-session' } };
      },
    },
  };
  const app = Fastify();
  await app.register(async routes => {
    protectExpectedSession(routes, auth);
    authenticateRoutes(routes, auth);
    routes.get('/whoami', async request => ({ user: (await requestSession(request, auth)).user.id }));
  });
  const headers = { 'x-tulipfarm-expected-session': 'current-session' };

  const first = await app.inject({ method: 'GET', url: '/whoami', headers });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { user: 'reader' });
  assert.equal(reads, 1);

  await app.inject({ method: 'GET', url: '/whoami', headers });
  assert.equal(reads, 2);
  await app.close();
});

test('a failed session read is retried by the next caller', async () => {
  let reads = 0;
  const auth = {
    api: {
      getSession: async () => {
        if (++reads === 1) throw new Error('database unavailable');
        return { user: { id: 'reader' }, session: { id: 'current-session' } };
      },
    },
  };
  const app = Fastify();
  app.get('/whoami', async request => {
    await requestSession(request, auth).catch(() => undefined);
    return { user: (await requestSession(request, auth)).user.id };
  });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/whoami' })).json(), { user: 'reader' });
  assert.equal(reads, 2);
  await app.close();
});
