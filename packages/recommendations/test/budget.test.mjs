import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createRecommendationBudget,
  RecommendationBudgetConflict,
  RecommendationBudgetConfigurationConflict,
} from '../dist/budget.js';

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
function row(attempt, changes = {}) {
  return {
    id: attempt.id,
    workspace_id: attempt.workspaceId,
    membership_id: attempt.membershipId,
    model_id: attempt.modelId,
    maximum_pico_usd: attempt.maximumPicoUsd,
    period_started_at: period,
    state: 'reserved',
    provider_pico_usd: null,
    created_at: period,
    dispatched_at: null,
    settled_at: null,
    projected_at: null,
    ...changes,
  };
}

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
    assertComplete() {
      assert.deepEqual(queue, []);
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

test('admission locks policy then platform then workspace and writes both counters', async () => {
  const attempt = input();
  const pool = recordingPool([[policy], [], [{ period }], [counter], [counter]]);
  assert.equal(await createRecommendationBudget(pool, limits).reserve(attempt), 'admitted');
  const locks = pool.calls.filter(call => call.sql.includes('FOR UPDATE'));
  assert.match(locks[0].sql, /budget_policy/);
  assert.deepEqual(
    locks.slice(1).map(call => call.values[1]),
    ['platform', `workspace:${attempt.workspaceId}`],
  );
  const update = pool.calls.find(call => call.sql.startsWith('UPDATE'));
  assert.deepEqual(update.values, [period, ['platform', `workspace:${attempt.workspaceId}`], '60']);
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  assert.deepEqual(pool.releases, [false]);
  assert.ok(pool.calls.every(call => !/tf_credit|tf_platform_recommendation_spend/.test(call.sql)));
  pool.assertComplete();
});

test('either cap denies the whole reservation, with bigint precision', async () => {
  for (const counters of [
    [{ reserved_pico_usd: '150', spent_pico_usd: '0' }, counter],
    [counter, { reserved_pico_usd: '20', spent_pico_usd: '21' }],
  ]) {
    const pool = recordingPool([[policy], [], [{ period }], ...counters.map(value => [value])]);
    assert.equal(await createRecommendationBudget(pool, limits).reserve(input()), 'capped');
    assert.equal(pool.calls.filter(call => call.sql.startsWith('UPDATE')).length, 0);
    assert.equal(
      pool.calls.filter(call => /INSERT INTO app.platform_recommendation_attempts/.test(call.sql)).length,
      0,
    );
    pool.assertComplete();
  }
  const large = '9007199254740993';
  const pool = recordingPool([
    [{ ...policy, workspace_pico_usd: large, platform_pico_usd: large }],
    [],
    [{ period }],
    [counter],
    [{ reserved_pico_usd: '9007199254740992', spent_pico_usd: '0' }],
  ]);
  assert.equal(
    await createRecommendationBudget(pool, {
      ...limits,
      workspacePicoUsd: large,
      platformPicoUsd: large,
    }).reserve({ ...input(), maximumPicoUsd: '2' }),
    'capped',
  );
});

test('a reservation replay never reserves again and verifies all immutable input', async () => {
  const attempt = input();
  const pool = recordingPool([[policy], [row(attempt)]]);
  assert.equal(await createRecommendationBudget(pool, limits).reserve(attempt), 'existing');
  assert.equal(pool.calls.filter(call => call.sql.startsWith('UPDATE')).length, 0);
  for (const changes of [
    { workspaceId: randomUUID() },
    { membershipId: randomUUID() },
    { modelId: 'different' },
    { maximumPicoUsd: '61' },
  ]) {
    const conflicting = recordingPool([[policy], [row(attempt)]]);
    await assert.rejects(
      createRecommendationBudget(conflicting, limits).reserve({
        ...attempt,
        ...changes,
      }),
      RecommendationBudgetConflict,
    );
    assert.equal(conflicting.calls.at(-1).sql, 'ROLLBACK');
  }
});

test('unknown keeps its complete reservation; later known replaces it once', async () => {
  const attempt = input();
  const unknown = recordingPool([[policy], [row(attempt)]]);
  await createRecommendationBudget(unknown, limits).settle({ id: attempt.id, providerPicoUsd: null });
  assert.equal(
    unknown.calls.filter(call => /UPDATE app.platform_recommendation_budget_counters/.test(call.sql)).length,
    0,
  );
  assert.ok(unknown.calls.some(call => /SET state='unknown'/.test(call.sql)));
  const retained = recordingPool([[policy], [row(attempt, { state: 'unknown', settled_at: period })]]);
  await createRecommendationBudget(retained, limits).settle({ id: attempt.id, providerPicoUsd: null });
  assert.equal(retained.calls.filter(call => call.sql.startsWith('UPDATE')).length, 0);
  const known = recordingPool([
    [policy],
    [row(attempt, { state: 'unknown', settled_at: period })],
    [counter],
    [counter],
  ]);
  await createRecommendationBudget(known, limits).settle({ id: attempt.id, providerPicoUsd: '17' });
  assert.deepEqual(
    known.calls.find(call => /UPDATE app.platform_recommendation_budget_counters/.test(call.sql)).values,
    [period, ['platform', `workspace:${attempt.workspaceId}`], '60', '17'],
  );
  const settled = row(attempt, { state: 'settled', provider_pico_usd: '17', settled_at: period });
  const replay = recordingPool([[policy], [settled]]);
  await createRecommendationBudget(replay, limits).settle({ id: attempt.id, providerPicoUsd: '17' });
  assert.equal(replay.calls.filter(call => call.sql.startsWith('UPDATE')).length, 0);
  for (const cost of ['18', null]) {
    await assert.rejects(
      createRecommendationBudget(recordingPool([[policy], [settled]]), limits).settle({
        id: attempt.id,
        providerPicoUsd: cost,
      }),
      RecommendationBudgetConflict,
    );
  }
});

test('only an undispatched reservation grants a provider dispatch', async () => {
  const attempt = input();
  const pool = recordingPool([[policy], [row(attempt)]]);
  assert.equal(await createRecommendationBudget(pool, limits).markDispatched(attempt.id), true);
  assert.match(
    pool.calls.find(call => call.sql.startsWith('UPDATE')).sql,
    /SET state='dispatched',dispatched_at=clock_timestamp\(\) WHERE id=\$1 AND state='reserved'/,
  );
  for (const state of ['dispatched', 'unknown', 'settled']) {
    const replay = recordingPool([
      [policy],
      [
        row(attempt, {
          state,
          dispatched_at: period,
          settled_at: state === 'dispatched' ? null : period,
          provider_pico_usd: state === 'settled' ? '12' : null,
        }),
      ],
    ]);
    assert.equal(await createRecommendationBudget(replay, limits).markDispatched(attempt.id), false);
    assert.equal(replay.calls.filter(call => call.sql.startsWith('UPDATE')).length, 0);
  }
  await assert.rejects(
    createRecommendationBudget(recordingPool([[policy], []]), limits).markDispatched(attempt.id),
    RecommendationBudgetConflict,
  );
});

test('missing attempts and mismatched deployment limits fail closed', async () => {
  await assert.rejects(
    createRecommendationBudget(recordingPool([[policy], []]), limits).settle({
      id: randomUUID(),
      providerPicoUsd: '0',
    }),
    RecommendationBudgetConflict,
  );
  const pool = recordingPool([[{ ...policy, period_seconds: 60 }]]);
  await assert.rejects(
    createRecommendationBudget(pool, limits).reserve(input()),
    RecommendationBudgetConfigurationConflict,
  );
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
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

test('lookup and pending projections retain amounts and stable workspace spend IDs', async () => {
  const attempt = input();
  const saved = row(attempt, { state: 'settled', provider_pico_usd: '17', settled_at: period });
  const pool = recordingPool([[saved], [saved]]);
  const budget = createRecommendationBudget(pool, limits);
  assert.equal((await budget.getAttempt(attempt.id)).providerPicoUsd, '17');
  const [projection] = await budget.listPendingProjections();
  assert.equal(projection.spendId, `recommendation:${attempt.id}`);
  assert.equal(projection.workspaceId, attempt.workspaceId);
  assert.equal(projection.providerPicoUsd, '17');
  await budget.markProjected({ id: attempt.id, providerPicoUsd: '17' });
  assert.match(pool.calls.at(-1).sql, /provider_pico_usd=\$2/);
  pool.assertComplete();
});
