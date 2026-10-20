import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import {
  CreditsExhausted,
  lockCredits,
  requireCredits,
  reserveCredits,
  settleCredits,
  settleCreditsAtReservation,
} from '../src/credits.ts';
import { reserveKnowledgeCredits } from '../src/knowledge-credits.ts';
import { creditAccountExtension } from '../src/credit-account.ts';

afterEach(resetExtensions);

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
        return { rows: [{ cost: sum('provider_pico_usd'), charged: sum('charged') }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE') && sql.includes('tf_credit_usage')) {
        Object.assign(usage.get(values[0]), { charged: values[1], provider_pico_usd: values[2] });
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
