import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../fixture.mjs';
import { creditSummary, reserveCredits, settleCredits, CreditsExhausted } from '@tulipfarm/workspace-storage/credits';
import { createConversationExecutor } from '../../src/runtime.ts';
import { applyCommonMigrations } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { hostedCreditPricingExtension } from '../../../workspace-storage/test/hosted-credit-pricing.mjs';

// Budget and balance assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

// These tests assert workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

test(
  'workspace credits grant once, serialize spending, settle once, and enforce all conversation admissions',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    const { workspace: w, store } = f;
    const tx = operation => f.runtime.transaction(w.id, commonCompatibility, operation);
    const reserve = (id, amount, activity = 'chat', agentId = null) =>
      tx(t =>
        reserveCredits(t, {
          id,
          flowId: id,
          modelId: 'fixture-model',
          agentId,
          activity,
          providerPicoUsd: amount,
          pricingRevision: 'fixture-v1',
        }),
      );
    const summary = () => tx(creditSummary);
    try {
      assert.equal((await summary()).available, 1000);
      await f.db.platform.query('BEGIN');
      await applyCommonMigrations(f.db.platform, w.id, await workspaceTableMigrations());
      await f.db.platform.query('COMMIT');
      assert.equal((await summary()).available, 1000);
      const chatId = randomUUID();
      const create = { commandId: randomUUID(), chatId };
      await store.create(w.id, w.userId, create);
      const sent = await store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Saved before exhaustion' }],
      });
      const ids = [randomUUID(), randomUUID()];
      const results = await Promise.allSettled(ids.map(id => reserve(id, '4000000000000')));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter(r => r.status === 'rejected' && r.reason instanceof CreditsExhausted).length, 1);
      assert.equal((await summary()).available, 400);
      const winner = ids[results.findIndex(r => r.status === 'fulfilled')];
      assert.equal(await reserve(winner, '4000000000000'), false);
      await Promise.all([
        tx(t => settleCredits(t, winner, '1000000000000')),
        tx(t => settleCredits(t, winner, '1000000000000')),
      ]);
      assert.equal((await summary()).available, 850);
      assert.equal((await summary()).used, 150);
      const agentId = randomUUID();
      await reserve('agent-call', '2000000000000', 'agent', agentId);
      await tx(t => settleCredits(t, 'agent-call', '1000000000000'));
      await reserve('other-call', '1000000000000', 'other');
      await tx(t => settleCredits(t, 'other-call', '0'));
      const totals = await summary();
      assert.equal(totals.used, 300);
      assert.equal(totals.days.length, 30);
      assert.equal(totals.days.at(-1).credits, 300);
      assert.deepEqual(totals.breakdown.map(row => row.activity).sort(), ['agent', 'chat', 'other']);
      assert.equal(totals.breakdown.find(row => row.activity === 'agent').agentId, agentId);
      await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=1000000000000 WHERE id=1`);
      await reserve('last', '1');
      assert.equal((await summary()).available, 0);
      assert.deepEqual(await store.create(w.id, w.userId, create), { id: chatId });
      await assert.rejects(
        store.create(w.id, w.userId, { commandId: randomUUID(), chatId: randomUUID() }),
        error => error.code === 'credits-exhausted',
      );
      await assert.rejects(
        store.send(w.id, w.userId, chatId, {
          commandId: randomUUID(),
          messageId: randomUUID(),
          parts: [{ kind: 'text', text: 'Blocked' }],
        }),
        error => error.code === 'credits-exhausted',
      );
      let calls = 0;
      const executor = createConversationExecutor(f.runtime, async () => {
        calls++;
        return 'Should not execute';
      });
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
        'idle',
      );
      assert.equal(calls, 0);
      await assert.rejects(
        store.retry(w.id, w.userId, chatId, sent.turnId, { commandId: randomUUID(), expectedGeneration: 0 }),
        error => error.code === 'credits-exhausted',
      );
      assert.equal((await store.history(w.id, w.userId, chatId)).messages[0].parts[0].text, 'Saved before exhaustion');
      await tx(t => settleCredits(t, 'last', '0'));
      assert.equal((await summary()).available, 1);
      await assert.rejects(reserve('too-expensive', '10000000000'), CreditsExhausted);
      for (const id of ['round-a', 'round-b']) {
        await tx(t =>
          reserveCredits(t, {
            id,
            flowId: 'shared-flow',
            modelId: 'fixture-model',
            agentId: null,
            activity: 'chat',
            providerPicoUsd: '1000000',
            pricingRevision: 'fixture-v1',
          }),
        );
        await tx(t => settleCredits(t, id, '1000000'));
        if (id === 'round-a')
          await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=1000000000000 WHERE id=1`);
      }
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT sum(charged)::text AS charged FROM ${f.table('tf_credit_usage')} WHERE flow_id='shared-flow'`,
          )
        ).rows[0].charged,
        '1000000000000',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'credit usage views show agent identities in workspace aggregates and limit personal rows',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    const { workspace: w } = f;
    const tx = operation => f.runtime.transaction(w.id, commonCompatibility, operation);
    const spend = async (flowId, activity, agentId) => {
      const id = randomUUID();
      await tx(t =>
        reserveCredits(t, {
          id,
          flowId,
          modelId: 'fixture-model',
          agentId,
          activity,
          providerPicoUsd: '1000000000000',
          pricingRevision: 'fixture-v1',
        }),
      );
      await tx(t => settleCredits(t, id, '1000000000000'));
    };
    try {
      const readable = randomUUID(),
        hidden = randomUUID(),
        ownChat = randomUUID(),
        otherChat = randomUUID(),
        ownRun = randomUUID();
      await spend(ownChat, 'chat', null);
      await spend(otherChat, 'chat', null);
      await spend(ownRun, 'agent', readable);
      await spend(randomUUID(), 'agent', readable);
      await spend(randomUUID(), 'agent', hidden);
      const workspace = await tx(t => creditSummary(t, { kind: 'workspace' }));
      assert.equal(workspace.scope, 'workspace');
      assert.deepEqual(
        workspace.breakdown
          .map(({ agentId, activity, calls, credits }) => ({ agentId, activity, calls, credits }))
          .sort((a, b) => a.activity.localeCompare(b.activity)),
        [
          { agentId: readable, activity: 'agent', calls: 2, credits: 300 },
          { agentId: hidden, activity: 'agent', calls: 1, credits: 150 },
          { agentId: null, activity: 'chat', calls: 2, credits: 300 },
        ].sort((a, b) => a.activity.localeCompare(b.activity)),
      );
      assert.equal(
        workspace.days.reduce((sum, day) => sum + day.credits, 0),
        750,
      );
      assert.equal(
        workspace.series.reduce((sum, row) => sum + row.credits, 0),
        750,
      );
      assert.equal(
        workspace.series.filter(row => row.agentId === readable).reduce((sum, row) => sum + row.credits, 0),
        300,
      );
      const personal = await tx(t => creditSummary(t, { kind: 'personal', flowIds: [ownChat, ownRun] }));
      assert.equal(personal.scope, 'personal');
      assert.deepEqual(
        personal.breakdown
          .map(({ agentId, activity, calls, credits }) => ({ agentId, activity, calls, credits }))
          .sort((a, b) => a.activity.localeCompare(b.activity)),
        [
          { agentId: readable, activity: 'agent', calls: 1, credits: 150 },
          { agentId: null, activity: 'chat', calls: 1, credits: 150 },
        ],
      );
      assert.equal(
        personal.days.reduce((sum, day) => sum + day.credits, 0),
        300,
      );
      assert.equal(
        personal.series.some(row => row.agentId === hidden),
        false,
      );
      assert.deepEqual(
        { used: personal.used, held: personal.held, unfunded: personal.unfunded },
        { used: 300, held: 0, unfunded: undefined },
      );
      assert.equal(workspace.used, 750);
      assert.equal(personal.available, workspace.available);
      const nothing = await tx(t => creditSummary(t, { kind: 'personal', flowIds: [] }));
      assert.deepEqual(nothing.breakdown, []);
      assert.equal(nothing.used, 0);
    } finally {
      await f.close();
    }
  },
);
