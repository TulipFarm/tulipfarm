import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { createCreditAlerts } from '../dist/credit-alerts.js';

afterEach(resetExtensions);

const credit = 1_000_000_000_000n;
const workspaceId = '6f1c0a52-35f4-4c4e-9a8e-0d3f1b2c4d5e';
const admin = '0b6a8d2e-4c1f-4e3a-9b7d-5f2e1c0a9d8b';

async function gate(account, methods = {}) {
  await registerExtension(
    {
      name: 'alert-gate',
      register(slots) {
        slots.creditGate({
          async available() {
            return account.available + account.grace;
          },
          async debit() {},
          async balance() {
            return { available: account.available, granted: 100n * credit, grace: account.grace };
          },
          ...methods,
        });
      },
    },
    { app: 'worker', env: {} },
  );
}

// One workspace whose alert row lives in memory and rolls back with a failed transaction.
function alerts(send = async () => {}) {
  const state = { level: null };
  const sent = [];
  const client = {
    async query(sql, values = []) {
      if (sql.startsWith('INSERT INTO') && sql.includes('tf_credit_alerts')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT level')) return { rows: [{ level: state.level }], rowCount: 1 };
      if (sql.startsWith('UPDATE') && sql.includes('tf_credit_alerts')) {
        state.level = values[0];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('tf_memberships')) return { rows: [{ user_id: admin }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const job = createCreditAlerts({
    runtime: {
      async transaction(_workspaceId, _compatibility, action) {
        const before = state.level;
        try {
          return await action({ client, schema: 'ws' });
        } catch (error) {
          state.level = before;
          throw error;
        }
      },
    },
    discover: async after => (after ? [] : [workspaceId]),
    profiles: { read: async (_workspaceId, ids) => ids.map(id => ({ id, email: `${id}@example.com` })) },
    workspace: async () => ({ slug: 'acme', name: 'Acme' }),
    env: { WEB_ORIGIN: 'https://app.example.com' },
    send: async (to, message) => {
      await send(to, message);
      sent.push([to, message.subject, message.text]);
    },
  });
  return { job, state, sent, run: () => job.run(new AbortController().signal) };
}

test('admins are emailed once per crossing, again after a top-up, and only the highest skipped level', async () => {
  const account = { available: 50n * credit, grace: 5n * credit };
  await gate(account);
  const { sent, run } = alerts();
  const subjects = () => sent.map(([, subject]) => subject);

  await run();
  assert.deepEqual(sent, [], 'no alert above 10% of granted credits');

  account.available = 10n * credit;
  await run();
  await run();
  assert.equal(sent.length, 1, 'low is sent once');
  const [to, , text] = sent[0];
  assert.equal(to, `${admin}@example.com`);
  assert.match(text, /10 credits/);
  assert.match(text, /https:\/\/app\.example\.com\/acme\/settings\/usage/);

  account.available = -1n * credit;
  await run();
  account.available = -5n * credit;
  await run();
  await run();
  assert.deepEqual(
    subjects(),
    [
      'Acme has used 90% of its credits',
      'Acme is out of credits and running on grace',
      'Work is paused in Acme: out of credits',
    ],
    'grace and stopped are each sent once',
  );

  account.available = 60n * credit;
  await run();
  account.available = -6n * credit;
  await run();
  assert.deepEqual(
    subjects().slice(3),
    ['Work is paused in Acme: out of credits'],
    'after a top-up, a fall straight past low and grace sends only stopped',
  );
});

test('a failed send is retried at the next check', async () => {
  const account = { available: 5n * credit, grace: 5n * credit };
  await gate(account);
  let fail = true;
  const { state, sent, run } = alerts(async () => {
    if (fail) throw new Error('mail down');
  });
  await assert.rejects(run(), AggregateError);
  assert.equal(state.level, null, 'the level is not recorded when its email fails');
  fail = false;
  await run();
  assert.equal(sent.length, 1);
  assert.equal(state.level, 'low');
});

test('without a gate balance there is no credit alert job', async () => {
  assert.equal(alerts().job, undefined, 'the default gate is unlimited');
  await gate({ available: 0n, grace: 0n }, { balance: undefined });
  assert.equal(alerts().job, undefined);
});
