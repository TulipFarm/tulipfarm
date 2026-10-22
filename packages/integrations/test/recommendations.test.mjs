import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  integrationRecommendationState,
  recordIntegrationRecommendationChange,
  watchIntegrationRecommendations,
} from '../src/recommendations.ts';

test('canonical capability sets exclude duplicate/order-only writes and scope losses to previous readers', async () => {
  const a = randomUUID(),
    b = randomUUID(),
    c = randomUUID(),
    sourceId = randomUUID();
  const calls = [];
  const tx = {
    schema: 'fixture',
    commonVersion: 30,
    client: {
      async query(sql, values) {
        calls.push({ sql, values });
        return { rows: [{ recorded: true }], rowCount: 1 };
      },
    },
  };
  const state = rows =>
    integrationRecommendationState(rows.map(([membership_id, facts]) => ({ membership_id, facts })));
  const before = state([
    [a, ['read', 'use']],
    [b, ['read']],
  ]);
  await recordIntegrationRecommendationChange(
    tx,
    sourceId,
    before,
    state([
      [b, ['read']],
      [a, ['use', 'read', 'use']],
    ]),
  );
  assert.equal(calls.length, 0);
  await recordIntegrationRecommendationChange(
    tx,
    sourceId,
    before,
    state([
      [a, ['read']],
      [b, ['read']],
      [c, ['read']],
    ]),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values.slice(1), ['integration', sourceId, [a, c].sort(), true]);
  assert.equal(JSON.stringify(calls[0].values).includes('use'), false);
  await recordIntegrationRecommendationChange(
    tx,
    sourceId,
    before,
    state([
      [a, ['read', 'use', 'source']],
      [b, ['read']],
    ]),
  );
  assert.equal(calls[1].values[4], false);
});

test('watcher uses the supplied transaction, propagates errors and respects migration gating', async () => {
  const id = randomUUID();
  let facts = ['read'];
  const calls = [];
  const tx = {
    schema: 'fixture',
    commonVersion: 0,
    client: {
      async query(...args) {
        calls.push(args);
        throw new Error('unexpected SQL');
      },
    },
  };
  const done = await watchIntegrationRecommendations(tx, id, async () => new Map([[id, [...facts]]]));
  facts = ['read', 'use'];
  await done();
  assert.deepEqual(calls, []);
  tx.commonVersion = 1;
  const failure = await watchIntegrationRecommendations(tx, id, async () => new Map([[id, [...facts]]]));
  facts = ['read'];
  await assert.rejects(failure(), /unexpected SQL/);
});
