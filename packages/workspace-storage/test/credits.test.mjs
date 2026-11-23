import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import {
  CreditsExhausted,
  creditBalance,
  holdReplyCredits,
  lockCredits,
  requireCredits,
  reserveCredits,
  settleCredits,
  settleCreditsAtReservation,
  settleReplyCredits,
} from '../src/credits.ts';
import { reserveKnowledgeCredits } from '../src/knowledge-credits.ts';
import { creditAccountExtension } from '../src/credit-account.ts';

afterEach(resetExtensions);

const usage = (workspace, id) => workspace.usage.get(id);

// A workspace schema with the meter tables and, optionally, the credit account.
function workspace(available) {
  const queries = [];
  const usage = new Map();
  const group = { known: '0', pending: '0', unfunded: '0' };
  const client = {
    query: async (sql, values = []) => {
      queries.push(sql);
      if (sql.includes('tf_credit_account')) {
        if (available === undefined) throw new Error('relation "tf_credit_account" does not exist');
        if (sql.startsWith('SELECT available')) return { rows: [{ available: available.toString() }], rowCount: 1 };
        if (sql.startsWith('UPDATE')) {
          available -= BigInt(values[0]);
          return { rows: [], rowCount: 1 };
        }
      }
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (sql.startsWith('SELECT 1 FROM') && sql.includes('tf_credit_usage'))
        return { rows: [], rowCount: usage.has(values[0]) ? 1 : 0 };
      if (sql.startsWith('INSERT INTO') && sql.includes('tf_credit_usage') && sql.includes('VALUES ($1,$2,$3,NULL')) {
        const [id, flow_id, model_id, activity, reserved, , plan_attempt_id] = values;
        usage.set(id, { flow_id, model_id, agent_id: null, activity, reserved, charged: null, plan_attempt_id });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO') && sql.includes('tf_credit_usage') && sql.includes('plan_milliseconds')) {
        const [id, flow_id, model_id, agent_id, activity, charged, provider_pico_usd, , , , fee_units] = values;
        usage.set(id, {
          flow_id,
          model_id,
          agent_id,
          activity,
          reserved: charged,
          charged,
          provider_pico_usd,
          fee_units,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO') && sql.includes('tf_credit_usage')) {
        const [id, flow_id, model_id, agent_id, activity, reserved] = values;
        usage.set(id, { flow_id, model_id, agent_id, activity, reserved, charged: null, provider_pico_usd: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT flow_id')) {
        const row = usage.get(values[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('COALESCE(sum(provider_pico_usd)')) {
        const rows = [...usage.values()].filter(row => row.flow_id === values[0]);
        const sum = key => rows.reduce((total, row) => total + BigInt(row[key] ?? 0), 0n).toString();
        return {
          rows: [{ cost: sum('provider_pico_usd'), fees: sum('fee_units'), charged: sum('charged') }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE') && sql.includes('tf_credit_usage')) {
        Object.assign(usage.get(values[0]), { charged: values[1], provider_pico_usd: values[2] });
        if (sql.includes('fee_units=$5')) usage.get(values[0]).fee_units = values[4];
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT known,pending,unfunded')) return { rows: [{ ...group }], rowCount: 1 };
      if (sql.startsWith('UPDATE') && sql.includes('tf_knowledge_credit_group')) {
        Object.assign(group, { known: values[0], pending: values[1], unfunded: values[2] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT * FROM') && sql.includes('tf_knowledge_credit_attempts'))
        return { rows: [], rowCount: 0 };
      if (sql.startsWith('INSERT INTO') && sql.includes('tf_knowledge_credit_attempts'))
        return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { tx: { client, schema: 'workspace' }, queries, usage, group, available: () => available };
}

const attempt = {
  id: 'a1',
  flowId: 'flow',
  modelId: 'model',
  agentId: null,
  activity: 'agent',
  providerPicoUsd: '1000000000',
  pricingRevision: 'r',
};
const knowledge = {
  id: 'k1',
  operationId: 'op',
  modelId: 'embed',
  profileId: 'p',
  pricingRevision: 'r',
  purpose: 'query',
  attribution: { kind: 'member', id: 'm' },
  taskFlowId: null,
  upperProviderPicoUsd: '1000000',
};

test('without a billing extension, credits are unlimited and usage is still metered', async () => {
  const { tx, queries, usage, group } = workspace(undefined);
  assert.equal(await lockCredits(tx), null);
  await requireCredits(tx);
  assert.equal(await reserveCredits(tx, attempt), true);
  assert.equal(await reserveCredits(tx, attempt), false, 'a replayed reservation is not admitted twice');
  assert.deepEqual(await settleCredits(tx, 'a1', '400000000'), {
    flowId: 'flow',
    modelId: 'model',
    agentId: null,
    activity: 'agent',
    providerPicoUsd: '400000000',
  });
  assert.equal(await settleCredits(tx, 'a1', '400000000'), null, 'a settled attempt is not settled twice');
  assert.deepEqual(
    { ...usage.get('a1') },
    {
      flow_id: 'flow',
      model_id: 'model',
      agent_id: null,
      activity: 'agent',
      reserved: '100000000000',
      charged: '40000000000',
      provider_pico_usd: '400000000',
    },
  );
  assert.equal((await reserveKnowledgeCredits(tx, knowledge)).admitted, true);
  assert.equal(group.unfunded, '0');
  assert.equal(group.pending, '100000000', 'the default pricing charges provider cost: 100 units per pico-USD');
  assert.ok(queries.every(sql => !sql.includes('tf_credit_account')));
});

test('a registered credit account funds reservations, refunds settlements and refuses exhausted work', async () => {
  await registerExtension(creditAccountExtension, { app: 'worker', env: {} });
  const funded = workspace(2_000_000_000_000n);
  assert.equal(await reserveCredits(funded.tx, attempt), true);
  assert.equal(funded.available(), 1_900_000_000_000n);
  await settleCredits(funded.tx, 'a1', '0');
  assert.equal(funded.available(), 2_000_000_000_000n);
  assert.equal((await reserveKnowledgeCredits(funded.tx, knowledge)).admitted, true);
  assert.equal(funded.available(), 1_999_900_000_000n);

  const empty = workspace(0n);
  await assert.rejects(requireCredits(empty.tx), CreditsExhausted);
  await assert.rejects(reserveCredits(empty.tx, attempt), CreditsExhausted);
  await assert.rejects(reserveKnowledgeCredits(empty.tx, knowledge), CreditsExhausted);
  assert.equal(empty.usage.size, 0);
});

test('registered credit pricing marks up and rounds each flow and the knowledge total', async () => {
  const credit = 1_000_000_000_000n;
  await registerExtension(
    {
      name: 'hosted-pricing',
      register(slots) {
        slots.creditPricing({ unitsPerPicoUsd: 150n, round: units => ((units + credit - 1n) / credit) * credit });
      },
    },
    { app: 'worker', env: {} },
  );
  const { tx, usage, group } = workspace(undefined);
  await reserveCredits(tx, attempt);
  await reserveCredits(tx, { ...attempt, id: 'a2' });
  assert.equal(usage.get('a1').reserved, credit.toString(), 'a reservation rounds up to a whole credit');
  await settleCredits(tx, 'a1', '400000000');
  await settleCredits(tx, 'a2', '400000000');
  assert.deepEqual(
    [usage.get('a1').charged, usage.get('a2').charged],
    [credit.toString(), '0'],
    'the flow total rounds once',
  );
  await reserveCredits(tx, { ...attempt, id: 'a3', flowId: 'other' });
  await settleCreditsAtReservation(tx, 'a3');
  assert.deepEqual([usage.get('a3').charged, usage.get('a3').provider_pico_usd], [credit.toString(), '6666666666']);
  await reserveKnowledgeCredits(tx, knowledge);
  assert.equal(group.pending, '150000000');
});

test('plan fees join each flow at the plan rate, round with its credit-paid calls and stay within the hold', async () => {
  const credit = 1_000_000_000_000n;
  await registerExtension(
    {
      name: 'hosted-pricing',
      register(slots) {
        slots.creditPricing({ unitsPerPicoUsd: 150n, round: units => ((units + credit - 1n) / credit) * credit });
      },
    },
    { app: 'worker', env: {} },
  );
  const hold = (id, preferred) => ({
    id,
    flowId: id,
    modelId: 'model',
    activity: 'chat',
    pricingRevision: 'r',
    minimum: credit,
    preferred,
    planAttemptId: null,
  });
  // Reply settlement reports usage per workspace, so the fake needs a real workspace schema name.
  const schema = 'ws_6f1c2b9a4d3e4f5a8b7c6d5e4f3a2b1c';
  // 0.6 credit of provider cost at the models rate, then a plan call whose fee is another 0.6 credit.
  const calls = id => [
    { id, modelId: 'model', pricingRevision: 'r', providerPicoUsd: '4000000000', planMilliseconds: null },
    {
      id: `${id}-plan`,
      modelId: 'plan-model',
      pricingRevision: 'r',
      providerPicoUsd: '0',
      feeUnits: 600_000_000_000n,
      planMilliseconds: 10,
    },
  ];

  const current = workspace(undefined);
  current.tx.schema = schema;
  current.tx.commonVersion = 108;
  assert.equal(await holdReplyCredits(current.tx, hold('h', 3n * credit)), 3n * credit);
  const settled = await settleReplyCredits(current.tx, 'h', calls('h'));
  assert.deepEqual(
    settled.map(call => call.charged),
    [credit, credit],
    'the flow rounds 0.6 + 0.6 credits once, to two credits',
  );
  assert.deepEqual(
    [usage(current, 'h-plan').provider_pico_usd, usage(current, 'h-plan').fee_units],
    ['0', '600000000000'],
    'a plan call records no provider cost and keeps its fee',
  );
  await reserveCredits(current.tx, { ...attempt, id: 'later', flowId: 'h', providerPicoUsd: '6000000000' });
  await settleCredits(current.tx, 'later', '6000000000');
  assert.equal(
    usage(current, 'later').charged,
    credit.toString(),
    'a later credit-paid call rounds 1.5 + 0.6 credits with the recorded fee',
  );

  const tight = workspace(undefined);
  tight.tx.schema = schema;
  tight.tx.commonVersion = 108;
  await holdReplyCredits(tight.tx, hold('t', credit));
  await assert.rejects(settleReplyCredits(tight.tx, 't', calls('t')), /credit-reservation-exceeded/);

  const before = workspace(undefined);
  before.tx.schema = schema;
  before.tx.commonVersion = 107;
  await holdReplyCredits(before.tx, hold('b', 3n * credit));
  assert.deepEqual(
    (await settleReplyCredits(before.tx, 'b', calls('b'))).map(call => call.charged),
    [credit, 0n],
    'a workspace before the fee migration does not charge plan fees',
  );
  assert.ok(before.queries.every(sql => !sql.includes('fee_units')));
});

test('the gate refuses work on balance plus grace and reports grace with the balance', async () => {
  const credit = 1_000_000_000_000n;
  const account = { balance: -2n * credit, grace: 5n * credit };
  await registerExtension(
    {
      name: 'grace-gate',
      register(slots) {
        slots.creditGate({
          async available() {
            return account.balance + account.grace;
          },
          async debit(_tx, units) {
            account.balance -= units;
          },
          async balance() {
            return { available: account.balance, granted: 10n * credit, grace: account.grace };
          },
        });
      },
    },
    { app: 'worker', env: {} },
  );
  const { tx } = workspace(undefined);
  assert.equal(await reserveCredits(tx, attempt), true, 'work continues below zero while grace remains');
  assert.deepEqual(await creditBalance(tx), { available: -2.1, granted: 10, grace: 5 });
  account.balance = -5n * credit;
  await assert.rejects(requireCredits(tx), CreditsExhausted);
  await assert.rejects(reserveCredits(tx, { ...attempt, id: 'a2' }), CreditsExhausted);
});
