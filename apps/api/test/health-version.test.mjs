import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { registerHealth, registerRoot } from '../src/health.ts';

test('root describes the API and links to docs and health', async t => {
  const app = Fastify();
  t.after(() => app.close());
  registerRoot(app);
  const response = await app.inject('/');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), {
    name: 'TulipFarm API',
    version: 'development',
    commit: 'development',
    docs: '/v1/docs',
    health: '/v1/health',
  });
});

test('actual health handlers preserve identity across healthy, degraded, and liveness responses', async t => {
  t.mock.method(Pool.prototype, 'query', async () => ({ rows: [{ value: 1 }] }));
  const names = ['HUNTSMAN_ENDPOINT', 'HUNTSMAN_TOKEN', 'HUNTSMAN_TOKEN_FILE', 'SEARXNG_ENDPOINT'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  for (const name of names) delete process.env[name];
  process.env.HUNTSMAN_ENDPOINT = 'http://huntsman:3000';
  process.env.SEARXNG_ENDPOINT = 'http://searxng:8080';
  const fetched = [];
  let publicWebUnavailable = false;
  t.mock.method(globalThis, 'fetch', async url => {
    fetched.push(String(url));
    if (publicWebUnavailable && String(url) === 'http://searxng:8080/healthz')
      throw new Error('public-web-unavailable');
    return new Response('healthy');
  });
  let failed = false;
  const app = Fastify();
  t.after(() => app.close());
  await app.register(
    async app =>
      registerHealth(app, {
        namespace: 'test',
        connection: {
          withDeadline: (_deadline, callback) => callback(),
          workflowService: { describeNamespace: async () => ({}) },
        },
        client: {
          workflow: {
            execute: async () => {
              if (failed) throw new Error('worker-unavailable');
              return 'ok';
            },
          },
        },
      }),
    { prefix: '/v1' },
  );
  for (const status of [200, 503]) {
    const response = await app.inject('/v1/health');
    assert.equal(response.statusCode, status);
    const body = response.json();
    assert.deepEqual(Object.keys(body).sort(), ['commit', 'services', 'status', 'version']);
    assert.equal(body.version, 'development');
    assert.equal(body.commit, 'development');
    assert.equal(body.status, failed ? 'degraded' : 'ok');
    assert.equal(body.services.workers.status, failed ? 'unavailable' : 'ok');
    assert.equal(body.services.postgres.status, 'ok');
    assert.equal(body.services.publicWeb.status, 'ok');
    assert.deepEqual(fetched, ['http://127.0.0.1:8233', 'http://huntsman:3000/health', 'http://searxng:8080/healthz']);
    fetched.length = 0;
    assert.equal(response.headers['cache-control'], 'no-store');
    failed = true;
  }
  publicWebUnavailable = true;
  const publicWebFailure = await app.inject('/v1/health');
  assert.equal(publicWebFailure.statusCode, 503);
  assert.equal(publicWebFailure.json().services.publicWeb.status, 'unavailable');
  const live = await app.inject('/v1/health/live');
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { status: 'ok', version: 'development', commit: 'development' });
});

test('health skips the Temporal UI and public-web probes when they are not configured', async t => {
  t.mock.method(Pool.prototype, 'query', async () => ({ rows: [{ value: 1 }] }));
  const previous = {
    HUNTSMAN_ENDPOINT: process.env.HUNTSMAN_ENDPOINT,
    SEARXNG_ENDPOINT: process.env.SEARXNG_ENDPOINT,
    TEMPORAL_UI_URL: process.env.TEMPORAL_UI_URL,
  };
  delete process.env.HUNTSMAN_ENDPOINT;
  delete process.env.SEARXNG_ENDPOINT;
  process.env.TEMPORAL_UI_URL = '';
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async url => {
    fetched.push(String(url));
    return new Response('healthy');
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(
    async app =>
      registerHealth(app, {
        namespace: 'test',
        connection: {
          withDeadline: (_deadline, callback) => callback(),
          workflowService: { describeNamespace: async () => ({}) },
        },
        client: { workflow: { execute: async () => 'ok' } },
      }),
    { prefix: '/v1' },
  );
  const response = await app.inject('/v1/health');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json().services).sort(), ['api', 'postgres', 'temporal', 'workers']);
  assert.deepEqual(fetched, []);
});

test('Huntsman health sends its token without scraping and optional storage checks follow the capability', async t => {
  t.mock.method(Pool.prototype, 'query', async () => ({ rows: [{ value: 1 }] }));
  const names = [
    'HUNTSMAN_ENDPOINT',
    'HUNTSMAN_TOKEN',
    'HUNTSMAN_TOKEN_FILE',
    'SEARXNG_ENDPOINT',
    'TEMPORAL_UI_URL',
    'WORKSPACE_STORAGE_CAPABILITY',
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  for (const name of names) delete process.env[name];
  process.env.HUNTSMAN_ENDPOINT = 'https://huntsman.example.com';
  process.env.HUNTSMAN_TOKEN = 'test-huntsman-token';
  process.env.TEMPORAL_UI_URL = '';
  delete process.env.WORKSPACE_STORAGE_CAPABILITY;
  let status = 200;
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    fetched.push({ url: String(url), options });
    return new Response('{}', { status });
  });
  const executions = [];
  const app = Fastify();
  t.after(() => app.close());
  await app.register(
    async app =>
      registerHealth(app, {
        namespace: 'test',
        connection: {
          withDeadline: (_deadline, callback) => callback(),
          workflowService: { describeNamespace: async () => ({}) },
        },
        client: {
          workflow: {
            execute: async name => {
              executions.push(name);
              return name === 'storageHealthCheck' ? 'isolated-v1' : 'ok';
            },
          },
        },
      }),
    { prefix: '/v1' },
  );
  const healthy = await app.inject('/v1/health');
  assert.equal(healthy.statusCode, 200);
  assert.equal(healthy.json().services.temporalUi, undefined);
  assert.equal(healthy.json().services.storageMaintenance, undefined);
  assert.deepEqual(executions, ['healthCheck']);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, 'https://huntsman.example.com/health');
  assert.deepEqual(fetched[0].options.headers, { authorization: 'Bearer test-huntsman-token' });
  assert.equal(fetched[0].options.method ?? 'GET', 'GET');
  assert.equal(fetched[0].options.redirect, 'error');
  assert.equal(fetched[0].options.body, undefined);
  assert.doesNotMatch(healthy.body, /test-huntsman-token/);
  process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';
  const withStorage = await app.inject('/v1/health');
  assert.equal(withStorage.statusCode, 200);
  assert.equal(withStorage.json().services.storageMaintenance.status, 'ok');
  for (status of [401, 503]) {
    const failed = await app.inject('/v1/health');
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().services.publicWeb.status, 'unavailable');
  }
  assert.equal((await app.inject('/health')).statusCode, 404);
});
