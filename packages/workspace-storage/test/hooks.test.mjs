import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { defineExtension, registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { workspaceIdFromSchema, workspaceNames } from '../src/names.ts';
import { afterCommit, inTransaction } from '../src/transactions.ts';
import { settleCredits } from '../src/credits.ts';
import { recordKnowledgeCreditOutcome } from '../src/knowledge-credits.ts';

const workspaceId = 'a477ec38-48dd-478c-a55f-01296e523a24';
const { schema } = workspaceNames(workspaceId);
const tick = () => new Promise(resolve => setImmediate(resolve));

async function recording() {
  const seen = [];
  await registerExtension(
    defineExtension({
      name: 'recorder',
      register(slots) {
        slots.hooks({
          'usage.recorded': payload => {
            seen.push(payload);
          },
        });
      },
    }),
    { app: 'worker', env: {} },
  );
  return seen;
}

afterEach(() => resetExtensions());

test('workspace ids round-trip through schema names', () => {
  assert.equal(workspaceIdFromSchema(schema), workspaceId);
  for (const bad of ['app', 'ws_123', `${schema}_runtime`]) assert.throws(() => workspaceIdFromSchema(bad));
});

test('afterCommit runs after COMMIT, drops on rollback, and runs now outside a transaction', async () => {
  const queries = [];
  const client = {
    query: async sql => {
      queries.push(sql);
      if (sql === 'COMMIT' && client.failCommit) throw new Error('commit failed');
      return { rows: [] };
    },
  };
  const order = [];
  await inTransaction(client, async tx => {
    afterCommit(tx, () => order.push(`callback after ${queries.at(-1)}`));
    afterCommit(tx, () => {
      throw new Error('ignored');
    });
    afterCommit(tx, () => order.push('second'));
    assert.deepEqual(order, []);
  });
  assert.deepEqual(order, ['callback after COMMIT', 'second']);

  await assert.rejects(
    inTransaction(client, async tx => {
      afterCommit(tx, () => order.push('rolled back'));
      throw new Error('no');
    }),
    /no/,
  );
  client.failCommit = true;
  await assert.rejects(
    inTransaction(client, async tx => {
      afterCommit(tx, () => order.push('commit failed'));
    }),
    /commit failed/,
  );
  afterCommit(client, () => order.push('outside'));
  assert.deepEqual(order, ['callback after COMMIT', 'second', 'outside']);
});

test('settled credit usage emits usage.recorded after commit only', async () => {
  const seen = await recording();
  const usage = {
    flow_id: 'chat:flow',
    model_id: 'model-a',
    agent_id: null,
    activity: 'chat',
    reserved: '1000000000000',
    charged: null,
  };
  const client = {
    query: async sql => {
      if (sql.startsWith('SELECT flow_id')) return { rows: [usage] };
      if (sql.startsWith('SELECT COALESCE')) return { rows: [{ cost: '0', charged: '0' }] };
      return { rows: [{ id: 1 }] };
    },
  };
  await inTransaction(client, async tx => {
    await settleCredits({ client: tx, schema }, 'attempt-1', '42');
    await tick();
    assert.deepEqual(seen, []);
  });
  await tick();
  assert.deepEqual(seen, [
    {
      workspaceId,
      usageId: 'attempt-1',
      flowId: 'chat:flow',
      modelId: 'model-a',
      activity: 'chat',
      providerPicoUsd: '42',
    },
  ]);

  await assert.rejects(
    inTransaction(client, async tx => {
      await settleCredits({ client: tx, schema }, 'attempt-2', '1');
      throw new Error('rollback');
    }),
    /rollback/,
  );
  usage.charged = '0';
  await inTransaction(client, tx => settleCredits({ client: tx, schema }, 'attempt-3', '1'));
  await tick();
  assert.equal(seen.length, 1);
});

test('known knowledge usage emits usage.recorded once, not on replay', async () => {
  const seen = await recording();
  const attemptId = '01234567-89ab-4def-8123-456789abcdef';
  const attempt = {
    id: attemptId,
    group_version: 1,
    operation_id: 'op',
    model_id: 'embed-1',
    profile_id: 'p',
    pricing_revision: 'r',
    purpose: 'query',
    attribution_kind: 'member',
    attribution_id: 'm',
    task_flow_id: null,
    upper_provider_pico_usd: '100',
    state: 'dispatched',
  };
  const group = { version: 1, known: '0', pending: '150', unfunded: '0' };
  const observation = {
    attempt_id: attemptId,
    provider_pico_usd: '10',
    input_tokens: '3',
    provider_request_id: null,
    charged: '0',
    above_bound: false,
  };
  const client = {
    query: async sql => {
      if (sql.includes('tf_knowledge_credit_group')) return { rows: [group] };
      if (sql.includes('FROM') && sql.includes('tf_knowledge_credit_attempts')) return { rows: [attempt] };
      if (sql.includes('FROM') && sql.includes('tf_knowledge_credit_observations')) return { rows: [observation] };
      if (sql.includes("SET state='known'")) attempt.state = 'known';
      return { rows: [{ available: '1000000000000' }] };
    },
  };
  const outcome = { attemptId, kind: 'known', providerPicoUsd: '10', inputTokens: '3', providerRequestId: null };
  await inTransaction(client, tx => recordKnowledgeCreditOutcome({ client: tx, schema }, outcome));
  await inTransaction(client, tx => recordKnowledgeCreditOutcome({ client: tx, schema }, outcome));
  await tick();
  assert.deepEqual(seen, [
    {
      workspaceId,
      usageId: attemptId,
      flowId: null,
      modelId: 'embed-1',
      activity: 'knowledge-query',
      providerPicoUsd: '10',
    },
  ]);
});
