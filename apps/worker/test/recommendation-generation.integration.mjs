import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { recordRecommendationChange, recommendationCompatibility } from '@tulipfarm/workspace-storage/recommendations';
import { createRecommendationBudget } from '@tulipfarm/recommendations/budget';
import { createRecommendationWork } from '@tulipfarm/recommendations/work';
import { readSavedRecommendations } from '@tulipfarm/recommendations';
import { createPersonalMemoryService } from '@tulipfarm/conversations/personal-memory';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createRecommendationActivities } from '../src/recommendation-activities.ts';

test(
  'event generation skips unchanged context, meters once and fences private recovery',
  { timeout: 60000 },
  async t => {
    const f = await conversationFixture();
    let pool;
    try {
      pool = new Pool({ connectionString: f.db.connectionString, max: 3 });
      const { id: workspaceId, membershipId, userId } = f.workspace;
      const limits = { workspacePicoUsd: '1000', platformPicoUsd: '1000', periodSeconds: 3600 };
      const budget = createRecommendationBudget(pool, limits);
      const work = createRecommendationWork(f.runtime);
      const memory = createPersonalMemoryService(f.runtime);
      const tx = operation => f.runtime.transaction(workspaceId, recommendationCompatibility, operation);
      const event = () =>
        tx(transaction =>
          recordRecommendationChange(transaction, {
            id: randomUUID(),
            kind: 'repair',
            sourceId: 'fixture',
            membershipIds: [membershipId],
          }),
        );
      const due = () =>
        f.db.platform.query(
          `UPDATE ${f.table('tf_recommendation_refresh')} SET due_at=clock_timestamp()-interval '1 second'`,
        );
      const saved = () => tx(transaction => readSavedRecommendations(transaction, membershipId));
      const events = [];
      let calls = 0,
        duringModel = async () => {},
        uncertain = false,
        breakPublication = false;
      const runtime = {
        ...f.runtime,
        transaction: (id, compatibility, operation) =>
          f.runtime.transaction(id, compatibility, transaction =>
            operation({
              ...transaction,
              client: {
                query: async (sql, values) => {
                  if (
                    breakPublication &&
                    sql.startsWith('INSERT INTO') &&
                    sql.includes('tf_recommendation_snapshots')
                  ) {
                    breakPublication = false;
                    throw new Error('fixture private text must not reach workflow history');
                  }
                  return transaction.client.query(sql, values);
                },
              },
            }),
          ),
      };
      const activities = createRecommendationActivities({
        runtime,
        eligible: async () => true,
        budget,
        log: event => events.push(event),
        model: {
          modelId: 'fixture/model',
          generate: async (context, slots, meter) => {
            const settle = await meter('10');
            calls++;
            assert.ok(slots > 0 && slots <= 5);
            if (uncertain) throw new Error('fixture provider secret');
            await duringModel();
            await settle('3');
            return JSON.stringify([
              {
                id: 'generated-fixture',
                kind: 'prompt',
                label: 'Plan a short checklist',
                brands: [],
                action: { kind: 'prompt', prompt: 'Help me plan a short checklist. Ask which process first.' },
                sources: context.entries.filter(entry => entry.kind === 'memory').map(entry => entry.key),
              },
            ]);
          },
        },
      });
      const run = () => activities.generateRecommendations(workspaceId, membershipId);
      const credits = async () =>
        (await f.db.platform.query(`SELECT to_jsonb(a) AS value FROM ${f.table('tf_credit_account')} a`)).rows;
      const beforeCredits = await credits();

      await t.test('five onboarding items and unchanged context require no model', async () => {
        await event();
        await due();
        assert.equal(await run(), 'published');
        assert.equal(calls, 0);
        assert.equal((await saved()).items.filter(item => item.kind === 'onboarding').length, 5);
        await event();
        await due();
        assert.equal(await run(), 'published');
        assert.equal(calls, 0);
        assert.ok(events.includes('unchanged'));
      });
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        randomUUID(),
        randomUUID(),
      ]);
      await memory.save(workspaceId, userId, { content: 'Prefer short checklists.', expectedRevision: 0 });
      await due();
      assert.equal(await run(), 'published');
      assert.equal(calls, 1);
      assert.equal((await saved()).items.length, 5);
      assert.equal((await saved()).items.at(-1).id, 'generated-fixture');
      await event();
      await due();
      await run();
      assert.equal(calls, 1, 'a repair without changed readable context does not call the model');

      await t.test('a transient publication failure resumes saved output without another provider call', async () => {
        await memory.save(workspaceId, userId, { content: 'Prefer short customer checklists.', expectedRevision: 1 });
        await due();
        breakPublication = true;
        await assert.rejects(run(), /^Error: recommendation-outcome-unavailable$/);
        assert.equal(calls, 2);
        assert.equal(
          (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_recommendation_results')}`))
            .rows[0].count,
          1,
        );
        assert.equal(await run(), 'published');
        assert.equal(calls, 2);
      });
      await t.test('memory deletion during inference cannot republish the old private context', async () => {
        await memory.save(workspaceId, userId, { content: 'Private changed preference.', expectedRevision: 2 });
        await due();
        duringModel = () => memory.delete(workspaceId, userId, { expectedRevision: 3 });
        assert.equal(await run(), 'superseded');
        assert.equal(calls, 3);
        assert.equal(
          (await saved()).items.some(item => item.id === 'generated-fixture'),
          false,
        );
        duringModel = async () => {};
        assert.equal(await run(), 'idle', 'the new event keeps its own fixed window');
        await due();
        await run();
        assert.equal(calls, 3, 'cleared memory restores five deterministic setup steps without a model call');
      });
      await t.test('unknown provider outcomes hold the reservation and do not loop', async () => {
        await memory.save(workspaceId, userId, { content: 'Another preference.', expectedRevision: 4 });
        await due();
        uncertain = true;
        assert.equal(await run(), 'failed');
        assert.equal(calls, 4);
        assert.equal(await run(), 'idle');
        assert.deepEqual(await work.pending(workspaceId), []);
        const attempts = (
          await f.db.platform.query(
            'SELECT state,maximum_pico_usd,provider_pico_usd FROM app.platform_recommendation_attempts ORDER BY created_at',
          )
        ).rows;
        assert.deepEqual(attempts.at(-1), { state: 'unknown', maximum_pico_usd: '10', provider_pico_usd: null });
        assert.equal(attempts.filter(row => row.state === 'settled').length, 3);
        assert.ok(events.includes('unknown-spend'));
        uncertain = false;
      });
      await t.test('interrupted dispatched work never dispatches a second provider request', async () => {
        await memory.save(workspaceId, userId, { content: 'Changed again.', expectedRevision: 5 });
        await due();
        const claim = await work.claim(workspaceId, membershipId);
        await budget.reserve({
          id: claim.attemptId,
          workspaceId,
          membershipId,
          modelId: 'fixture/model',
          maximumPicoUsd: '10',
        });
        await budget.markDispatched(claim.attemptId);
        assert.equal(await run(), 'failed');
        assert.equal(calls, 4);
        assert.equal((await budget.getAttempt(claim.attemptId)).state, 'unknown');
      });
      await t.test('a cap pauses work without a model dispatch or a workspace credit charge', async () => {
        await f.db.platform.query(`UPDATE app.platform_recommendation_budget_counters SET spent_pico_usd=1000`);
        await memory.save(workspaceId, userId, { content: 'Final preference.', expectedRevision: 6 });
        await due();
        assert.equal(await run(), 'budget-paused');
        assert.equal(calls, 4);
        assert.equal((await saved()).status, 'budget-paused');
        assert.equal(await run(), 'idle');
        assert.deepEqual(await credits(), beforeCredits);
      });
    } finally {
      await pool?.end();
      await f.close();
    }
  },
);
