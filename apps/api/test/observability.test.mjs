import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { commonCompatibility, createWorkspaceRuntime, workspaceNames } from '@tulipfarm/workspace-storage/runtime';
import { registerObservability } from '../src/observability.ts';

test('HTTP hooks preserve responses and record reviewed error codes without private data', async t => {
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (line, ...args) => {
    if (typeof line !== 'string' || !line.startsWith('{"level":')) return write(line, ...args);
    lines.push(line);
    return true;
  });
  const app = Fastify();
  t.after(() => app.close());
  registerObservability(app);
  app.get('/denied/:id', (_request, reply) => reply.code(403).send({ error: 'access-denied', detail: 'PRIVATE DATA' }));
  app.get('/unexpected', (_request, reply) => reply.code(500).send({ error: 'private-user-text' }));
  app.get('/success', () => ({ error: 'access-denied' }));
  app.get('/throw', () => {
    throw Object.assign(new Error('PRIVATE EXCEPTION'), { code: 'provider-unavailable' });
  });
  app.get('/database', () => {
    throw new Error('PRIVATE WRAPPER', { cause: Object.assign(new Error('PRIVATE SQL'), { code: '42501' }) });
  });
  for (const [url, status] of [
    ['/denied/private-id', 403],
    ['/unexpected', 500],
    ['/success', 200],
    ['/throw', 500],
    ['/database', 500],
  ]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, status);
  }
  t.mock.restoreAll();
  const records = lines.map(line => JSON.parse(line)).filter(record => record.event === 'request_completed');
  assert.equal(records.length, 5);
  assert.deepEqual(
    records.slice(0, 4).map(record => record['error.code']),
    ['access-denied', 'unclassified', undefined, 'provider-unavailable'],
  );
  assert.equal(records[4]['error.code'], '42501');
  assert.match(records[4]['error.reason'], /permission/i);
  assert.equal(records[0]['http.route'], '/denied/:id');
  assert.ok(records.every(record => record.duration_ms >= 0));
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|private-id|private-user-text/);
});

test('a sender that leaves frees its queued workspace storage place', async t => {
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const names = workspaceNames(workspaceId);
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      if (sql === 'SELECT session_user, current_user')
        return { rows: [{ session_user: names.runtime, current_user: names.runtime }] };
      if (sql.includes('FROM pg_proc')) return { rows: [], rowCount: 1 };
      if (sql.includes('app.workspace_access')) return { rows: [{ allowed: true }] };
      if (sql.includes('count(*)')) return { rows: [{ version: commonCompatibility.maximum }] };
      return { rows: [] };
    },
    release() {},
  });
  t.mock.method(Pool.prototype, 'connect', async () => client);
  const runtime = createWorkspaceRuntime({
    maxConcurrentTransactions: 1,
    replicaCount: 1,
    reservedConnections: 0,
    databaseConnectionBudget: 16,
    background: () => false,
    resolveCredential: async () => ({
      workspaceId,
      generation: 1,
      connectionString: `postgres://${names.runtime}:password@localhost/database`,
    }),
  });
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const busy = runtime.transaction(workspaceId, commonCompatibility, async () => {
    entered.resolve();
    await release.promise;
  });
  const app = Fastify();
  t.after(async () => {
    release.resolve();
    await app.close();
    await runtime.close();
  });
  registerObservability(app);
  const failure = Promise.withResolvers();
  app.get('/read', () =>
    runtime
      .transaction(workspaceId, commonCompatibility, async () => 'read')
      .catch(error => {
        failure.resolve(error);
        throw error;
      }),
  );
  await entered.promise;
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const sent = httpRequest(`${address}/read`);
  sent.on('error', () => undefined);
  sent.end();
  while (runtime.stats().queuedTransactions === 0) await delay(5);
  sent.destroy();
  assert.equal((await failure.promise).code, 'caller_left');
  assert.equal(runtime.stats().queuedTransactions, 0);
  release.resolve();
  await busy;
});
