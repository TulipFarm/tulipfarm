import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { fixture, connect, denied, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import {
  createRecommendationBudget,
  RecommendationBudgetConflict,
  RecommendationBudgetConfigurationConflict,
} from '../dist/budget.js';

test(
  'platform recommendation admission and accounting use one shared application ledger',
  { timeout: 60_000 },
  async t => {
    const db = await fixture();
    let pool;
    try {
      await loadPlatformBaseline(db.platform);
      const workspaces = [await db.create(), await db.create()];
      pool = new Pool({
        connectionString: db.connectionString,
        max: 12,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10_000,
      });
      const limits = { workspacePicoUsd: '100', platformPicoUsd: '150', periodSeconds: 3600 };
      const make = (workspace = workspaces[0], changes = {}) => ({
        id: randomUUID(),
        workspaceId: workspace.id,
        membershipId: workspace.membershipId,
        modelId: 'fixture/model',
        maximumPicoUsd: '30',
        ...changes,
      });
      const reset = async (changes = {}) => {
        await db.platform.query(`TRUNCATE app.platform_recommendation_attempts,
        app.platform_recommendation_budget_counters,app.platform_recommendation_budget_policy`);
        return createRecommendationBudget(pool, { ...limits, ...changes });
      };
      const counters = async () =>
        (
          await db.platform.query(`SELECT scope,reserved_pico_usd,spent_pico_usd
      FROM app.platform_recommendation_budget_counters ORDER BY scope`)
        ).rows;

      await t.test('concurrent workspace admissions cannot exceed the workspace cap', async () => {
        const budget = await reset({ platformPicoUsd: '1000' });
        const attempts = Array.from({ length: 24 }, () => make());
        const outcomes = await Promise.all(attempts.map(attempt => budget.reserve(attempt)));
        assert.equal(outcomes.filter(outcome => outcome === 'admitted').length, 3);
        assert.equal(outcomes.filter(outcome => outcome === 'capped').length, 21);
        for (const row of await counters()) {
          assert.equal(row.reserved_pico_usd, '90');
          assert.equal(row.spent_pico_usd, '0');
        }
        assert.equal(
          (await db.platform.query('SELECT count(*)::int AS count FROM app.platform_recommendation_attempts')).rows[0]
            .count,
          3,
        );
      });

      await t.test('a failed projection is deferred durably without starving another workspace', async () => {
        const budget = await reset();
        const blocked = make(workspaces[0]),
          healthy = make(workspaces[1]);
        for (const attempt of [blocked, healthy]) {
          await budget.reserve(attempt);
          await budget.settle({ id: attempt.id, providerPicoUsd: '3' });
        }
        assert.equal((await budget.listPendingProjections(1))[0].id, blocked.id);
        await budget.deferProjection(blocked.id);
        const restarted = createRecommendationBudget(pool, limits);
        assert.equal((await restarted.listPendingProjections(1))[0].id, healthy.id);
        await restarted.markProjected({ id: healthy.id, providerPicoUsd: '3' });
        assert.deepEqual(await restarted.listPendingProjections(), []);
        await db.platform.query(
          `UPDATE app.platform_recommendation_attempts SET next_projection_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [blocked.id],
        );
        assert.equal((await restarted.listPendingProjections(1))[0].id, blocked.id);
        assert.equal((await restarted.getAttempt(blocked.id)).state, 'settled');
        await assert.rejects(restarted.deferProjection('missing'), RecommendationBudgetConflict);
      });

      await t.test('different workspace schemas compete for the same global cap', async () => {
        const budget = await reset({ platformPicoUsd: '100' });
        const attempts = Array.from({ length: 24 }, (_, index) => make(workspaces[index % 2]));
        const outcomes = await Promise.all(attempts.map(attempt => budget.reserve(attempt)));
        assert.equal(outcomes.filter(outcome => outcome === 'admitted').length, 3);
        const rows = await counters();
        assert.equal(rows.find(row => row.scope === 'platform').reserved_pico_usd, '90');
        assert.equal(
          rows.filter(row => row.scope !== 'platform').reduce((sum, row) => sum + BigInt(row.reserved_pico_usd), 0n),
          90n,
        );
      });

      await t.test(
        'duplicate attempt and settlement races charge exactly once and reject changed identity',
        async () => {
          const budget = await reset();
          const attempt = make();
          const outcomes = await Promise.all(Array.from({ length: 12 }, () => budget.reserve(attempt)));
          assert.equal(outcomes.filter(outcome => outcome === 'admitted').length, 1);
          assert.equal(outcomes.filter(outcome => outcome === 'existing').length, 11);
          for (const change of [
            { workspaceId: workspaces[1].id },
            { membershipId: randomUUID() },
            { modelId: 'other-model' },
            { maximumPicoUsd: '31' },
          ]) {
            await assert.rejects(budget.reserve({ ...attempt, ...change }), RecommendationBudgetConflict);
          }
          await Promise.all(Array.from({ length: 12 }, () => budget.settle({ id: attempt.id, providerPicoUsd: '7' })));
          for (const row of await counters()) assert.deepEqual([row.reserved_pico_usd, row.spent_pico_usd], ['0', '7']);
          await assert.rejects(budget.settle({ id: attempt.id, providerPicoUsd: '8' }), RecommendationBudgetConflict);
          await assert.rejects(budget.settle({ id: attempt.id, providerPicoUsd: null }), RecommendationBudgetConflict);
          assert.equal(await budget.reserve(attempt), 'existing');
        },
      );

      await t.test('dispatch CAS permits one provider call and survives a recreated activity', async () => {
        const budget = await reset();
        const attempt = make();
        await budget.reserve(attempt);
        const outcomes = await Promise.all(Array.from({ length: 12 }, () => budget.markDispatched(attempt.id)));
        assert.equal(outcomes.filter(Boolean).length, 1);
        const restarted = createRecommendationBudget(pool, limits);
        const dispatched = await restarted.getAttempt(attempt.id);
        assert.equal(dispatched.state, 'dispatched');
        assert.ok(dispatched.dispatchedAt instanceof Date);
        assert.equal(dispatched.settledAt, null);
        assert.equal(await restarted.markDispatched(attempt.id), false);
        await restarted.settle({ id: attempt.id, providerPicoUsd: null });
        assert.equal((await restarted.getAttempt(attempt.id)).state, 'unknown');
        assert.equal(await restarted.markDispatched(attempt.id), false);
        for (const row of await counters()) assert.deepEqual([row.reserved_pico_usd, row.spent_pico_usd], ['30', '0']);
        await restarted.settle({ id: attempt.id, providerPicoUsd: '9' });
        assert.equal(await restarted.markDispatched(attempt.id), false);
        assert.equal((await restarted.getAttempt(attempt.id)).providerPicoUsd, '9');
      });

      await t.test('known undispatched settlement prevents a later provider dispatch', async () => {
        const budget = await reset();
        const attempt = make();
        await budget.reserve(attempt);
        await budget.settle({ id: attempt.id, providerPicoUsd: '0' });
        assert.equal(await budget.markDispatched(attempt.id), false);
        assert.equal((await budget.getAttempt(attempt.id)).dispatchedAt, null);
      });

      await t.test('unknown usage holds its upper bound and known usage projects without fake zero spend', async () => {
        const budget = await reset();
        const attempt = make(workspaces[0], { maximumPicoUsd: '100' });
        await budget.reserve(attempt);
        assert.equal((await budget.getAttempt(attempt.id)).state, 'reserved');
        await budget.settle({ id: attempt.id, providerPicoUsd: null });
        await budget.settle({ id: attempt.id, providerPicoUsd: null });
        assert.equal((await budget.getAttempt(attempt.id)).state, 'unknown');
        assert.equal(await budget.reserve(make()), 'capped');
        assert.deepEqual(await budget.listPendingProjections(), []);
        for (const row of await counters()) assert.deepEqual([row.reserved_pico_usd, row.spent_pico_usd], ['100', '0']);
        await budget.settle({ id: attempt.id, providerPicoUsd: '12' });
        const [projection] = await budget.listPendingProjections();
        assert.equal(projection.id, attempt.id);
        assert.equal(projection.spendId, `recommendation:${attempt.id}`);
        assert.equal(projection.providerPicoUsd, '12');
        const runtime = await connect(db.login(workspaces[0]));
        try {
          for (let replay = 0; replay < 2; replay += 1) {
            await runtime.query(
              `INSERT INTO "${workspaces[0].names.schema}".tf_platform_recommendation_spend
            (id,membership_id,model_id,provider_pico_usd,created_at) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(id) DO NOTHING`,
              [
                projection.spendId,
                projection.membershipId,
                projection.modelId,
                projection.providerPicoUsd,
                projection.createdAt,
              ],
            );
            const saved = (
              await runtime.query(
                `SELECT id,membership_id,model_id,provider_pico_usd
            FROM "${workspaces[0].names.schema}".tf_platform_recommendation_spend WHERE id=$1`,
                [projection.spendId],
              )
            ).rows;
            assert.deepEqual(saved, [
              {
                id: projection.spendId,
                membership_id: projection.membershipId,
                model_id: projection.modelId,
                provider_pico_usd: '12',
              },
            ]);
          }
        } finally {
          await runtime.end();
        }
        assert.equal((await budget.listPendingProjections()).length, 1);
        await assert.rejects(
          budget.markProjected({ id: attempt.id, providerPicoUsd: '13' }),
          RecommendationBudgetConflict,
        );
        assert.equal((await budget.listPendingProjections()).length, 1);
        await budget.markProjected({ id: attempt.id, providerPicoUsd: '12' });
        await budget.markProjected({ id: attempt.id, providerPicoUsd: '12' });
        assert.deepEqual(await budget.listPendingProjections(), []);
        assert.equal(await budget.reserve(make()), 'admitted');
      });

      await t.test('exact integer limits, explicit zero, and actual over-bound charges remain truthful', async () => {
        const cap = '9007199254740993';
        const budget = await reset({ workspacePicoUsd: cap, platformPicoUsd: cap });
        const attempt = make(workspaces[0], { maximumPicoUsd: cap });
        assert.equal(await budget.reserve(attempt), 'admitted');
        assert.equal(await budget.reserve(make(workspaces[1], { maximumPicoUsd: '1' })), 'capped');
        await budget.settle({ id: attempt.id, providerPicoUsd: '0' });
        const inaccurate = make(workspaces[1], { maximumPicoUsd: '1' });
        assert.equal(await budget.reserve(inaccurate), 'admitted');
        await budget.settle({ id: inaccurate.id, providerPicoUsd: '9007199254740994' });
        assert.equal(await budget.reserve(make()), 'capped');
        assert.equal((await counters()).find(row => row.scope === 'platform').spent_pico_usd, '9007199254740994');
      });

      await t.test('period rollover cannot double-reserve an ID or settle into the new period', async () => {
        const budget = await reset();
        const attempt = make(workspaces[0], { maximumPicoUsd: '100' });
        await budget.reserve(attempt);
        await budget.settle({ id: attempt.id, providerPicoUsd: null });
        await db.platform.query(`UPDATE app.platform_recommendation_attempts
        SET period_started_at=period_started_at-interval '1 hour';
        UPDATE app.platform_recommendation_budget_counters
        SET period_started_at=period_started_at-interval '1 hour'`);
        assert.equal(await budget.reserve(attempt), 'existing');
        assert.equal(await budget.reserve(make(workspaces[0], { maximumPicoUsd: '100' })), 'admitted');
        await budget.settle({ id: attempt.id, providerPicoUsd: '5' });
        const rows = (
          await db.platform.query(`SELECT reserved_pico_usd,spent_pico_usd
        FROM app.platform_recommendation_budget_counters WHERE scope='platform' ORDER BY period_started_at`)
        ).rows;
        assert.deepEqual(rows, [
          { reserved_pico_usd: '0', spent_pico_usd: '5' },
          { reserved_pico_usd: '100', spent_pico_usd: '0' },
        ]);
        await assert.rejects(
          createRecommendationBudget(pool, { ...limits, periodSeconds: 60 }).reserve(make()),
          RecommendationBudgetConfigurationConflict,
        );
        await assert.rejects(
          createRecommendationBudget(pool, { ...limits, platformPicoUsd: '151' }).reserve(make()),
          RecommendationBudgetConfigurationConflict,
        );
      });

      await t.test('a failed attempt write rolls back both counters', async () => {
        const budget = await reset();
        const attempt = make();
        await db.platform.query(`CREATE FUNCTION app.fail_recommendation_attempt() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-write-failed'; END $$;
        CREATE TRIGGER fail_recommendation_attempt BEFORE INSERT ON app.platform_recommendation_attempts
        FOR EACH ROW EXECUTE FUNCTION app.fail_recommendation_attempt()`);
        try {
          await assert.rejects(budget.reserve(attempt), /fixture-write-failed/);
          assert.equal(await budget.getAttempt(attempt.id), null);
          assert.deepEqual(await counters(), []);
        } finally {
          await db.platform.query(`DROP TRIGGER fail_recommendation_attempt ON app.platform_recommendation_attempts;
          DROP FUNCTION app.fail_recommendation_attempt()`);
        }
        assert.equal(await budget.reserve(attempt), 'admitted');
      });

      await t.test('workspace capabilities cannot read or mutate the platform ledger or lose credits', async () => {
        for (const workspace of workspaces) {
          const runtime = await connect(db.login(workspace));
          try {
            for (const table of [
              'platform_recommendation_budget_policy',
              'platform_recommendation_budget_counters',
              'platform_recommendation_attempts',
            ]) {
              await denied(runtime, `SELECT * FROM app.${table}`);
              await denied(runtime, `DELETE FROM app.${table}`);
            }
            const credit = (
              await runtime.query(`SELECT available,granted FROM "${workspace.names.schema}".tf_credit_account`)
            ).rows[0];
            assert.equal(credit.available, credit.granted);
          } finally {
            await runtime.end();
          }
        }
      });
    } finally {
      if (pool) await pool.end();
      await db.close();
    }
  },
);
