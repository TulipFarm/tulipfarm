import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRecommendationBudget, RecommendationBudgetConflict } from '../dist/budget.js';

const limits = { workspacePicoUsd: '100', platformPicoUsd: '200', periodSeconds: 3600 };
const input = () => ({
  id: randomUUID(),
  workspaceId: randomUUID(),
  membershipId: randomUUID(),
  modelId: 'fixture/model-v1',
  maximumPicoUsd: '60',
});
const period = new Date('2026-10-11T04:00:00Z');
const policy = { workspace_pico_usd: '100', platform_pico_usd: '200', period_seconds: 3600 };
const counter = { reserved_pico_usd: '0', spent_pico_usd: '0' };
function recordingPool(reads = [], failOn) {
  const calls = [];
  const releases = [];
  const queue = [...reads];
  let connects = 0;
  return {
    calls,
    releases,
    get connects() {
      return connects;
    },
    async connect() {
      connects += 1;
      return {
        async query(sql, values) {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          calls.push({ sql: normalized, values });
          if (failOn?.test(normalized)) throw new Error('fixture-query-failure');
          if (normalized.startsWith('SELECT')) {
            assert.ok(queue.length, `Unexpected query: ${normalized}`);
            return { rows: queue.shift(), rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
        release(destroy) {
          releases.push(destroy);
        },
      };
    },
  };
}

test('budget limits fail closed without a database connection', () => {
  const pool = recordingPool();
  for (const value of [
    undefined,
    {},
    { ...limits, workspacePicoUsd: '0' },
    { ...limits, platformPicoUsd: '-1' },
    { ...limits, platformPicoUsd: '1.5' },
    { ...limits, platformPicoUsd: '01' },
    { ...limits, workspacePicoUsd: 100 },
    { ...limits, workspacePicoUsd: '1'.repeat(31) },
    ...[0, -1, 0.5, Infinity, 31_536_001].map(periodSeconds => ({ ...limits, periodSeconds })),
  ]) {
    assert.throws(() => createRecommendationBudget(pool, value));
  }
  assert.equal(pool.connects, 0);
});

test('invalid reservations and settlements are rejected before connecting', async () => {
  const pool = recordingPool();
  const budget = createRecommendationBudget(pool, limits);
  for (const change of [
    { maximumPicoUsd: '0' },
    { id: 'private text' },
    { workspaceId: 'not-a-workspace' },
    { modelId: 'a private prompt' },
  ]) {
    await assert.rejects(budget.reserve({ ...input(), ...change }));
  }
  await assert.rejects(budget.settle({ id: randomUUID(), providerPicoUsd: '-1' }));
  await assert.rejects(budget.settle({ id: randomUUID() }));
  await assert.rejects(budget.listPendingProjections(1001));
  assert.equal(pool.connects, 0);
});

test('a missing attempt cannot be settled', async () => {
  await assert.rejects(
    createRecommendationBudget(recordingPool([[policy], []]), limits).settle({
      id: randomUUID(),
      providerPicoUsd: '0',
    }),
    RecommendationBudgetConflict,
  );
});

test('database failures roll back and release instead of returning admitted', async () => {
  const pool = recordingPool(
    [[policy], [], [{ period }], [counter], [counter]],
    /^INSERT INTO app.platform_recommendation_attempts/,
  );
  await assert.rejects(createRecommendationBudget(pool, limits).reserve(input()), /fixture-query-failure/);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
  assert.deepEqual(pool.releases, [false]);
});
