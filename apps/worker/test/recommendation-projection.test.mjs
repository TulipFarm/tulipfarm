import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { projectRecommendationSpend } from '../src/recommendation-activities.ts';

test('one failed workspace projection does not stop later receipts or acknowledge uncommitted spend', async () => {
  const receipts = Array.from({ length: 3 }, () => ({
    id: randomUUID(),
    spendId: randomUUID(),
    workspaceId: randomUUID(),
    membershipId: randomUUID(),
    modelId: 'fixture/model',
    providerPicoUsd: '7',
    createdAt: new Date(),
  }));
  const acknowledged = [],
    deferred = [],
    logged = [],
    committed = [];
  const budget = {
    listPendingProjections: async () => receipts,
    markProjected: async ({ id }) => {
      assert.ok(committed.includes(id));
      if (id === receipts[1].id) throw new Error('fixture acknowledgement unavailable');
      acknowledged.push(id);
    },
    deferProjection: async id => {
      deferred.push(id);
    },
  };
  const runtime = {
    transaction: async (workspaceId, _compatibility, operation) => {
      const receipt = receipts.find(item => item.workspaceId === workspaceId);
      if (receipt === receipts[0]) throw new Error('fixture workspace unavailable');
      await operation({ schema: 'fixture', client: { query: async () => ({ rowCount: 1, rows: [] }) } });
      committed.push(receipt.id);
    },
  };
  await projectRecommendationSpend({
    runtime,
    budget,
    log: (event, workspaceId, membershipId) => logged.push({ event, workspaceId, membershipId }),
  });
  assert.deepEqual(
    deferred,
    receipts.slice(0, 2).map(receipt => receipt.id),
  );
  assert.deepEqual(acknowledged, [receipts[2].id]);
  assert.deepEqual(
    logged,
    receipts
      .slice(0, 2)
      .map(({ workspaceId, membershipId }) => ({ event: 'spend-projection-retry', workspaceId, membershipId })),
  );
});
