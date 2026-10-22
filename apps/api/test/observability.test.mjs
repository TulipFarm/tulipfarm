import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
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
