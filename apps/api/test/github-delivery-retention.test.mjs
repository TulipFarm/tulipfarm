import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerGitHubDeliveryRetention } from '../src/github-delivery-retention.ts';

test('an invalid retention fails at startup', () => {
  const pool = { query: async () => assert.fail('not queried at startup') };
  for (const value of ['0', '721', 'six'])
    assert.throws(
      () => registerGitHubDeliveryRetention(Fastify(), pool, { GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS: value }),
      /1 to 720/,
    );
});

test('cleanup runs every minute with the configured retention and logs only deletions', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  const removed = [3, 0];
  const pool = {
    query: async (text, values) => {
      if (text.includes('prune_github_event_bodies')) return { rows: [{ removed: 0 }] };
      calls.push(values);
      return { rows: [{ removed: removed.shift() ?? 0 }] };
    },
  };
  const app = Fastify();
  const logged = [];
  app.log.info = (fields, message) => logged.push({ fields, message });
  registerGitHubDeliveryRetention(app, pool, { GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS: '12' });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    t.mock.timers.tick(59_999);
    await settle();
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(calls, [[12, 500]]);
    assert.deepEqual(logged, [{ fields: { deleted: 3 }, message: 'Deleted processed GitHub webhook deliveries' }]);
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(logged.length, 1);
  } finally {
    await app.close();
  }
});

test('bodies are swept every ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  const pool = {
    query: async (text, values) => {
      if (text.includes('prune_github_event_bodies')) calls.push(values);
      return { rows: [{ removed: 0 }] };
    },
  };
  const app = Fastify();
  registerGitHubDeliveryRetention(app, pool, {});
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    t.mock.timers.tick(9_999);
    await settle();
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(calls, [[500]]);
  } finally {
    await app.close();
  }
});
