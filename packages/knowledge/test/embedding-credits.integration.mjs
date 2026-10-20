import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { reserveCredits, settleCredits, creditSummary, CreditsExhausted } from '@tulipfarm/workspace-storage/credits';
import {
  reserveKnowledgeCredits,
  markKnowledgeDispatched,
  recordKnowledgeCreditOutcome,
  readKnowledgeCreditGroup,
  KnowledgeCreditConflict,
} from '@tulipfarm/workspace-storage/knowledge-credits';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { hostedCreditPricingExtension } from '../../workspace-storage/test/hosted-credit-pricing.mjs';

// Budget and balance assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

// These tests assert workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

test('knowledge credit aggregate through restricted workspace transactions', async t => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 16,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 80,
      resolveCredential: async id => {
        const workspace = db.workspaces.find(item => item.id === id);
        assert.ok(workspace);
        return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
      },
    });
    async function workspace(balance = '1000000000000') {
      const ws = await db.create(migrations);
      const table = name => qualified(ws.names.schema, name);
      await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1,granted=$1`, [balance]);
      const tx = operation =>
        runtime.transaction(ws.id, { minimum: migrations.length, maximum: migrations.length }, operation);
      const input = (overrides = {}) => ({
        id: randomUUID(),
        operationId: randomUUID(),
        modelId: 'embedding-model',
        profileId: 'embedding-profile-v1',
        pricingRevision: 'azure-price-v1',
        purpose: 'query',
        attribution: { kind: 'member', id: ws.membershipId },
        taskFlowId: null,
        upperProviderPicoUsd: '1000',
        ...overrides,
      });
      const reserve = value => tx(transaction => reserveKnowledgeCredits(transaction, value));
      const dispatch = id => tx(transaction => markKnowledgeDispatched(transaction, id));
      const outcome = value => tx(transaction => recordKnowledgeCreditOutcome(transaction, value));
      const known = (id, cost = '1000', extra = {}) =>
        outcome({
          kind: 'known',
          attemptId: id,
          providerPicoUsd: cost,
          inputTokens: '10',
          providerRequestId: null,
          ...extra,
        });
      const summary = () => tx(creditSummary);
      const group = () => tx(readKnowledgeCreditGroup);
      return { ws, tx, table, input, reserve, dispatch, outcome, known, summary, group };
    }

    await t.test('P1 summary reports chat spend and holds without creating knowledge credit totals', async () => {
      const w = await workspace('5000000000000');
      const flowId = randomUUID();
      const chat = id => ({
        id,
        flowId,
        modelId: 'chat-model',
        agentId: null,
        activity: 'chat',
        providerPicoUsd: '1000',
        pricingRevision: 'old-price',
      });
      for (const id of ['settled-first', 'settled-second']) {
        await w.tx(tx => reserveCredits(tx, chat(id)));
        await w.tx(tx => settleCredits(tx, id, '1000'));
      }
      await w.tx(tx => reserveCredits(tx, chat('held')));
      const summary = await w.summary();
      assert.equal(summary.granted, 5);
      assert.equal(summary.available, 3);
      assert.equal(summary.used, 1);
      assert.equal(summary.held, 1);
      assert.equal(summary.unfunded, 0);
      assert.deepEqual(summary.breakdown, [
        { modelId: 'chat-model', agentId: null, activity: 'chat', credits: 1, calls: 3 },
      ]);
      assert.equal(
        summary.days.reduce((sum, day) => sum + day.credits, 0),
        1,
      );
      assert.deepEqual(await w.group(), {
        version: 1,
        known: '0',
        pending: '0',
        settled: '0',
        held: '0',
        commitment: '0',
        unfunded: '0',
      });
    });

    await t.test('100 tiny concurrent queries use one credit, including funded headroom at zero balance', async () => {
      const w = await workspace();
      const attempts = Array.from({ length: 100 }, () => w.input());
      const reservations = await Promise.all(attempts.map(w.reserve));
      assert.equal(reservations.filter(item => item.admitted).length, 100);
      assert.deepEqual(await w.group(), {
        version: 1,
        known: '0',
        pending: '15000000',
        settled: '0',
        held: '1000000000000',
        commitment: '1000000000000',
        unfunded: '0',
      });
      assert.equal((await w.summary()).available, 0);
      await Promise.all(
        attempts.map(async attempt => {
          assert.equal(await w.dispatch(attempt.id), true);
          assert.equal((await w.known(attempt.id)).state, 'known');
        }),
      );
      assert.deepEqual(await w.group(), {
        version: 1,
        known: '15000000',
        pending: '0',
        settled: '1000000000000',
        held: '0',
        commitment: '1000000000000',
        unfunded: '0',
      });
      const summary = await w.summary();
      assert.equal(summary.used, 1);
      assert.equal(summary.held, 0);
      assert.deepEqual(summary.breakdown, [
        { modelId: 'embedding-model', agentId: null, activity: 'knowledge-query', credits: 1, calls: 100 },
      ]);
      assert.equal(
        summary.days.reduce((sum, day) => sum + day.credits, 0),
        1,
      );
      const next = w.input();
      assert.equal((await w.reserve(next)).admitted, true);
      await assert.rejects(w.reserve(w.input({ upperProviderPicoUsd: '6666666667' })), CreditsExhausted);
    });

    await t.test('competing full commitments cannot overdraw and duplicate identity cannot change', async () => {
      const w = await workspace();
      const first = w.input({ upperProviderPicoUsd: '6666666666' });
      const second = w.input({ upperProviderPicoUsd: '6666666666' });
      const results = await Promise.allSettled([w.reserve(first), w.reserve(second)]);
      assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(
        results.filter(item => item.status === 'rejected' && item.reason instanceof CreditsExhausted).length,
        1,
      );
      const admitted = results[0].status === 'fulfilled' ? first : second;
      const replay = await w.reserve(admitted);
      assert.equal(replay.admitted, false);
      assert.equal(replay.state, 'reserved');
      for (const changed of [
        { operationId: randomUUID() },
        { purpose: 'reindex' },
        { profileId: 'different' },
        { pricingRevision: 'different' },
        { attribution: { kind: 'source', id: randomUUID() } },
        { taskFlowId: randomUUID() },
        { upperProviderPicoUsd: '1' },
      ]) {
        await assert.rejects(w.reserve({ ...admitted, ...changed }), KnowledgeCreditConflict);
      }
      assert.deepEqual(await w.group(), {
        version: 1,
        known: '0',
        pending: '999999999900',
        settled: '0',
        held: '1000000000000',
        commitment: '1000000000000',
        unfunded: '0',
      });
    });

    await t.test(
      'dispatch is claimed once, unknown keeps its bound, retry has a new identity, late known settles once',
      async () => {
        const w = await workspace('2000000000000');
        const first = w.input({ upperProviderPicoUsd: '6666666666', taskFlowId: randomUUID() });
        await w.reserve(first);
        assert.deepEqual((await Promise.all([w.dispatch(first.id), w.dispatch(first.id)])).sort(), [false, true]);
        await w.outcome({ kind: 'unknown', attemptId: first.id });
        await w.outcome({ kind: 'unknown', attemptId: first.id });
        assert.equal((await w.group()).held, '1000000000000');
        assert.equal(await w.dispatch(first.id), false);
        await assert.rejects(w.outcome({ kind: 'undispatched', attemptId: first.id }), KnowledgeCreditConflict);
        const retry = { ...first, id: randomUUID() };
        assert.equal((await w.reserve(retry)).admitted, true);
        assert.equal((await w.group()).pending, '1999999999800');
        await w.dispatch(retry.id);
        await w.known(retry.id, '500');
        const late = await w.known(first.id, '1000');
        assert.equal(late.group.known, '225000');
        assert.equal(late.group.pending, '0');
        assert.equal((await w.known(first.id, '1000')).group.known, '225000');
        assert.equal((await w.outcome({ kind: 'unknown', attemptId: first.id })).state, 'known');
        await assert.rejects(w.known(first.id, '1001'), KnowledgeCreditConflict);
        await assert.rejects(w.known(first.id, '1000', { inputTokens: '11' }), KnowledgeCreditConflict);
        await assert.rejects(w.known(first.id, '1000', { providerRequestId: 'different' }), KnowledgeCreditConflict);
        const observations = (
          await w.tx(tx =>
            tx.client.query(
              `SELECT a.task_flow_id,o.provider_pico_usd FROM ${w.table('tf_knowledge_credit_attempts')} a JOIN ${w.table('tf_knowledge_credit_observations')} o ON o.attempt_id=a.id ORDER BY o.provider_pico_usd`,
            ),
          )
        ).rows;
        assert.deepEqual(observations, [
          { task_flow_id: first.taskFlowId, provider_pico_usd: '500' },
          { task_flow_id: first.taskFlowId, provider_pico_usd: '1000' },
        ]);
        assert.equal((await w.summary()).used, 1);
        assert.equal((await w.summary()).available, 1);
      },
    );

    await t.test('release and dispatch race cannot both succeed, and released attempts cannot be reused', async () => {
      const w = await workspace();
      const attempt = w.input();
      await w.reserve(attempt);
      const [release, dispatch] = await Promise.allSettled([
        w.outcome({ kind: 'undispatched', attemptId: attempt.id }),
        w.dispatch(attempt.id),
      ]);
      if (release.status === 'fulfilled') {
        assert.equal(release.value.state, 'released');
        assert.equal(dispatch.status, 'fulfilled');
        assert.equal(dispatch.value, false);
        assert.equal((await w.reserve(attempt)).state, 'released');
        assert.equal((await w.outcome({ kind: 'undispatched', attemptId: attempt.id })).state, 'released');
        assert.equal((await w.summary()).available, 1);
      } else {
        assert.ok(release.reason instanceof KnowledgeCreditConflict);
        assert.equal(dispatch.value, true);
        await w.known(attempt.id);
        assert.equal((await w.summary()).used, 1);
      }
    });

    await t.test('release recomputes shared hold rather than refunding an attempt rounded amount', async () => {
      const w = await workspace();
      const first = w.input(),
        second = w.input();
      await w.reserve(first);
      await w.reserve(second);
      await w.outcome({ kind: 'undispatched', attemptId: first.id });
      assert.equal((await w.group()).pending, '150000');
      assert.equal((await w.summary()).held, 1);
      assert.equal((await w.summary()).available, 0);
      await w.outcome({ kind: 'undispatched', attemptId: second.id });
      assert.equal((await w.summary()).available, 1);
      assert.equal((await w.group()).held, '0');
    });
    await t.test(
      'dispatch owner can release proven-unsent work after marker or recovery without recording usage',
      async () => {
        const w = await workspace();
        for (const recovered of [false, true]) {
          const attempt = w.input();
          await w.reserve(attempt);
          await assert.rejects(
            w.outcome({ kind: 'marked-undispatched', attemptId: attempt.id }),
            KnowledgeCreditConflict,
          );
          assert.equal(await w.dispatch(attempt.id), true);
          await assert.rejects(w.outcome({ kind: 'undispatched', attemptId: attempt.id }), KnowledgeCreditConflict);
          if (recovered) await w.outcome({ kind: 'unknown', attemptId: attempt.id });
          const proof = { kind: 'marked-undispatched', attemptId: attempt.id };
          assert.equal((await w.outcome(proof)).state, 'released');
          assert.equal((await w.outcome(proof)).state, 'released');
          assert.equal((await w.group()).pending, '0');
          assert.equal((await w.summary()).available, 1);
          await assert.rejects(w.known(attempt.id), KnowledgeCreditConflict);
        }
        const settled = w.input();
        await w.reserve(settled);
        await w.dispatch(settled.id);
        await w.known(settled.id);
        await assert.rejects(
          w.outcome({ kind: 'marked-undispatched', attemptId: settled.id }),
          KnowledgeCreditConflict,
        );
        assert.equal(
          (
            await w.tx(tx =>
              tx.client.query(`SELECT count(*)::int AS count FROM ${w.table('tf_knowledge_credit_observations')}`),
            )
          ).rows[0].count,
          1,
        );
      },
    );

    await t.test(
      'observation above its bound persists exact cost and unfunded reconciliation without clipping',
      async () => {
        const w = await workspace();
        const attempt = w.input({ upperProviderPicoUsd: '1' });
        await w.reserve(attempt);
        await w.dispatch(attempt.id);
        const result = await w.known(attempt.id, '10000000000');
        assert.equal(result.reconciliation, true);
        assert.deepEqual(result.group, {
          version: 1,
          known: '1500000000000',
          pending: '0',
          settled: '2000000000000',
          held: '0',
          commitment: '2000000000000',
          unfunded: '1000000000000',
        });
        const summary = await w.summary();
        assert.equal(summary.used, 2);
        assert.equal(summary.available, 0);
        assert.equal(summary.unfunded, 1);
        assert.deepEqual(
          (
            await w.tx(tx =>
              tx.client.query(
                `SELECT provider_pico_usd,above_bound FROM ${w.table('tf_knowledge_credit_observations')} WHERE attempt_id=$1`,
                [attempt.id],
              ),
            )
          ).rows,
          [{ provider_pico_usd: '10000000000', above_bound: true }],
        );
        await assert.rejects(w.reserve(w.input()), CreditsExhausted);
        await db.platform.query(
          `UPDATE ${w.table('tf_credit_account')} SET available=500000000000,granted=1500000000000`,
        );
        const next = w.input();
        await assert.rejects(w.reserve(next), CreditsExhausted);
        assert.equal((await w.summary()).available, 0.5);
        assert.equal((await w.group()).unfunded, '1000000000000');
        await db.platform.query(
          `UPDATE ${w.table('tf_credit_account')} SET available=1000000000000,granted=2000000000000`,
        );
        const tooLarge = w.input({ upperProviderPicoUsd: '6666666666' });
        await w.tx(async tx => {
          await assert.rejects(reserveKnowledgeCredits(tx, tooLarge), CreditsExhausted);
        });
        assert.equal((await w.summary()).available, 1);
        assert.equal((await w.group()).unfunded, '1000000000000');
        assert.equal((await w.group()).pending, '0');
        const reconciled = await w.reserve(next);
        assert.equal(reconciled.admitted, true);
        assert.equal(reconciled.group.unfunded, '0');
        assert.equal(reconciled.group.known, '1500000000000');
        assert.equal(reconciled.group.pending, '150000');
        assert.equal((await w.summary()).available, 0);
        assert.equal((await w.reserve(next)).admitted, false);
        assert.equal((await w.summary()).used, 2);
        assert.equal((await w.summary()).breakdown[0].calls, 1);
      },
    );

    await t.test(
      'concurrent new admissions collect replenished debt once and fund only one added commitment',
      async () => {
        const w = await workspace();
        const old = w.input({ upperProviderPicoUsd: '1' });
        await w.reserve(old);
        await w.dispatch(old.id);
        await w.known(old.id, '10000000000');
        await db.platform.query(
          `UPDATE ${w.table('tf_credit_account')} SET available=2000000000000,granted=3000000000000`,
        );
        const attempts = [
          w.input({ upperProviderPicoUsd: '6666666666' }),
          w.input({ upperProviderPicoUsd: '6666666666' }),
        ];
        const results = await Promise.allSettled(attempts.map(w.reserve));
        assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.admitted).length, 1);
        assert.equal(
          results.filter(result => result.status === 'rejected' && result.reason instanceof CreditsExhausted).length,
          1,
        );
        assert.deepEqual(await w.group(), {
          version: 1,
          known: '1500000000000',
          pending: '999999999900',
          settled: '2000000000000',
          held: '1000000000000',
          commitment: '3000000000000',
          unfunded: '0',
        });
        const summary = await w.summary();
        assert.equal(summary.available, 0);
        assert.equal(summary.used, 2);
        assert.equal(summary.held, 1);
        assert.equal(summary.breakdown[0].calls, 1);
      },
    );

    await t.test('mixed historical chat and knowledge share the account without changing flow rounding', async () => {
      const w = await workspace('5000000000000');
      const flowId = randomUUID();
      const chat = id => ({
        id,
        flowId,
        modelId: 'chat-model',
        agentId: null,
        activity: 'chat',
        providerPicoUsd: '1000',
        pricingRevision: 'old-price',
      });
      const first = randomUUID(),
        second = randomUUID();
      const embedding = w.input({ purpose: 'ingestion', attribution: { kind: 'source', id: randomUUID() } });
      await Promise.all([w.tx(tx => reserveCredits(tx, chat(first))), w.reserve(embedding)]);
      await w.tx(tx => settleCredits(tx, first, '1000'));
      await w.tx(tx => reserveCredits(tx, chat(second)));
      await w.tx(tx => settleCredits(tx, second, '1000'));
      await w.dispatch(embedding.id);
      await w.known(embedding.id);
      const held = w.input({ upperProviderPicoUsd: '6666666666', purpose: 'reindex' });
      await w.reserve(held);
      await w.dispatch(held.id);
      await w.outcome({ kind: 'unknown', attemptId: held.id });
      const summary = await w.summary();
      assert.equal(summary.used, 2);
      assert.equal(summary.held, 1);
      assert.equal(summary.available, 2);
      assert.deepEqual(summary.breakdown, [
        { modelId: 'chat-model', agentId: null, activity: 'chat', credits: 1, calls: 2 },
        { modelId: 'embedding-model', agentId: null, activity: 'knowledge-ingestion', credits: 1, calls: 1 },
      ]);
      assert.equal(JSON.stringify(summary).includes(embedding.attribution.id), false);
    });

    await t.test('reporting boundary does not reset rounding and delayed settlement uses observation day', async () => {
      const w = await workspace();
      const old = w.input();
      await w.reserve(old);
      await w.dispatch(old.id);
      await w.known(old.id);
      await db.platform.query(
        `UPDATE ${w.table('tf_knowledge_credit_observations')} SET observed_at=clock_timestamp()-interval '40 days' WHERE attempt_id=$1`,
        [old.id],
      );
      const next = w.input({ purpose: 'reindex' });
      await w.reserve(next);
      await db.platform.query(
        `UPDATE ${w.table('tf_knowledge_credit_attempts')} SET created_at=clock_timestamp()-interval '40 days' WHERE id=$1`,
        [next.id],
      );
      await w.dispatch(next.id);
      await w.known(next.id);
      const summary = await w.summary();
      assert.equal(summary.used, 1);
      assert.equal(summary.available, 0);
      assert.equal(
        summary.days.reduce((sum, day) => sum + day.credits, 0),
        0,
      );
      assert.deepEqual(summary.breakdown, [
        { modelId: 'embedding-model', agentId: null, activity: 'knowledge-reindex', credits: 0, calls: 1 },
      ]);
      assert.equal((await w.group()).known, '300000');
    });

    await t.test('integer precision survives costs beyond Number safe integer', async () => {
      const w = await workspace('2000000000000000000');
      const attempt = w.input({ upperProviderPicoUsd: '9007199254740993' });
      await w.reserve(attempt);
      await w.dispatch(attempt.id);
      const result = await w.known(attempt.id, '9007199254740993', { inputTokens: '9007199254740993' });
      assert.equal(result.group.known, '1351079888211148950');
      assert.equal(result.group.settled, '1351080000000000000');
      const account = (await w.tx(tx => tx.client.query(`SELECT available FROM ${w.table('tf_credit_account')}`)))
        .rows[0];
      assert.equal(account.available, '648920000000000000');
      const summary = await w.summary();
      assert.equal(summary.used, 1351080);
      assert.equal(summary.available, 648920);
      const nearBoundary = await workspace('1000000000001000000000000');
      const fractional = nearBoundary.input({ upperProviderPicoUsd: '6666666666666666666667' });
      await nearBoundary.reserve(fractional);
      await nearBoundary.dispatch(fractional.id);
      assert.equal(
        (await nearBoundary.known(fractional.id, '6666666666666666666667')).group.settled,
        '1000000000001000000000000',
      );
      assert.equal((await nearBoundary.summary()).used, 1000000000001);
    });

    await t.test(
      'rollback and replay cannot lose or double-charge observation; runtime cannot alter immutable usage',
      async () => {
        const w = await workspace();
        const attempt = w.input();
        await assert.rejects(
          w.tx(async tx => {
            await reserveKnowledgeCredits(tx, attempt);
            throw new Error('crash-after-reserve');
          }),
          /crash-after-reserve/,
        );
        assert.equal((await w.reserve(attempt)).admitted, true);
        await w.dispatch(attempt.id);
        const known = {
          kind: 'known',
          attemptId: attempt.id,
          providerPicoUsd: '1000',
          inputTokens: '10',
          providerRequestId: 'provider-receipt',
        };
        await assert.rejects(
          w.tx(async tx => {
            await recordKnowledgeCreditOutcome(tx, known);
            throw new Error('crash-before-commit');
          }),
          /crash-before-commit/,
        );
        assert.equal((await w.group()).known, '0');
        assert.equal((await w.group()).pending, '150000');
        const results = await Promise.all([w.outcome(known), w.outcome(known)]);
        assert.equal(results[0].group.known, '150000');
        assert.equal(results[1].group.known, '150000');
        const login = await connect(db.login(w.ws));
        try {
          await denied(
            login,
            `UPDATE ${w.table('tf_knowledge_credit_observations')} SET provider_pico_usd=0 WHERE attempt_id=$1`,
            [attempt.id],
          );
          await denied(login, `DELETE FROM ${w.table('tf_knowledge_credit_observations')} WHERE attempt_id=$1`, [
            attempt.id,
          ]);
          await denied(login, `UPDATE ${w.table('tf_knowledge_credit_attempts')} SET purpose='reindex' WHERE id=$1`, [
            attempt.id,
          ]);
        } finally {
          await login.end();
        }
        assert.equal((await w.summary()).used, 1);
        assert.equal((await w.summary()).breakdown[0].calls, 1);
      },
    );
  } finally {
    await runtime?.close();
    await db.close();
  }
});
