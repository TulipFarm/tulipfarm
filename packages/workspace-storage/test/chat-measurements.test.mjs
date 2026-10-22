import assert from 'node:assert/strict';
import test from 'node:test';
import { withChatMeasurements } from '@tulipfarm/observability';
import { inTransaction, resetClient } from '../src/transactions.ts';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { reserveCredits, settleCredits, CreditsExhausted } from '../src/credits.ts';
import { creditAccountExtension } from '../src/credit-account.ts';

function clockAndLogs(t) {
  let clock = 0;
  const records = [];
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(process.stdout, 'write', line => {
    records.push(JSON.parse(line));
    return true;
  });
  return {
    records,
    advance: milliseconds => {
      clock += milliseconds;
    },
  };
}

test('chat transaction timings measure actual BEGIN, settings, COMMIT and reset queries', async t => {
  const { records, advance } = clockAndLogs(t);
  const queries = [];
  const client = {
    query: async sql => {
      queries.push(sql);
      advance(sql === 'COMMIT' ? 300 : 100);
      return { rows: [] };
    },
  };
  const result = await withChatMeasurements(async () => {
    const value = await inTransaction(client, async () => {
      advance(500);
      return 42;
    });
    await resetClient(client);
    return value;
  });
  assert.equal(result, 42);
  assert.deepEqual(
    records.map(r => [r.operation, r.duration_ms]),
    [
      ['chat.detail.storage-begin', 100],
      ['chat.detail.storage-settings', 100],
      ['chat.detail.storage-commit', 300],
      ['chat.detail.storage-reset', 100],
    ],
  );
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.deepEqual(queries.slice(-2), ['COMMIT', 'DISCARD ALL']);
  const count = records.length;
  await inTransaction(client, async () => 1);
  assert.equal(records.length, count, 'non-chat transactions do not emit chat details');
});

test('failed commit is measured, rollback preserves the original exception', async t => {
  const { records, advance } = clockAndLogs(t);
  const failure = new Error('PRIVATE DATABASE MESSAGE');
  const client = {
    query: async sql => {
      advance(100);
      if (sql === 'COMMIT') throw failure;
      return { rows: [] };
    },
  };
  await assert.rejects(
    withChatMeasurements(() => inTransaction(client, async () => 42)),
    error => error === failure,
  );
  assert.deepEqual(
    records.slice(-2).map(r => [r.operation, r.outcome, r.duration_ms]),
    [
      ['chat.detail.storage-commit', 'error', 100],
      ['chat.detail.storage-rollback', 'success', 100],
    ],
  );
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE DATABASE MESSAGE|SELECT|ROLLBACK/);
});

test('credit lock timings isolate the locking queries without changing accounting', async t => {
  await registerExtension(creditAccountExtension, { app: 'worker', env: {} });
  t.after(resetExtensions);
  const { records, advance } = clockAndLogs(t);
  const queries = [];
  const client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes('FOR UPDATE')) advance(250);
      else if (!sql.includes('pg_advisory_xact_lock')) advance(50);
      if (sql.includes('SELECT available')) return { rows: [{ available: '5000000000000' }], rowCount: 1 };
      if (sql.includes('SELECT flow_id'))
        return {
          rows: [
            {
              flow_id: 'PRIVATE FLOW',
              model_id: 'fixture',
              agent_id: null,
              activity: 'chat',
              reserved: '1000000000000',
              charged: null,
            },
          ],
        };
      if (sql.includes('COALESCE(sum(')) return { rows: [{ cost: '0', charged: '0' }] };
      if (sql.startsWith('UPDATE') && sql.includes('RETURNING')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const tx = { client, schema: 'private_schema' };
  await withChatMeasurements(async () => {
    assert.equal(
      await reserveCredits(tx, {
        id: 'PRIVATE USAGE',
        flowId: 'PRIVATE FLOW',
        modelId: 'fixture',
        agentId: null,
        activity: 'chat',
        providerPicoUsd: '1',
        pricingRevision: 'fixture',
      }),
      true,
    );
    await settleCredits(tx, 'PRIVATE USAGE', '1');
  });
  assert.deepEqual(
    records.map(r => [r.operation, r.duration_ms]),
    [
      ['chat.detail.credit-account-lock', 250],
      ['chat.detail.credit-account-lock', 250],
      ['chat.detail.credit-usage-lock', 250],
    ],
  );
  assert.equal(queries.filter(q => q.sql.startsWith('INSERT')).length, 1);
  assert.equal(queries.filter(q => q.sql.startsWith('UPDATE')).length, 3);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|private_schema|SELECT|UPDATE/);
});

test('denied credit admission still fails without writing a usage row', async t => {
  await registerExtension(creditAccountExtension, { app: 'worker', env: {} });
  t.after(resetExtensions);
  const { records, advance } = clockAndLogs(t);
  let inserted = false;
  const client = {
    query: async sql => {
      advance(100);
      if (sql.startsWith('INSERT')) inserted = true;
      if (sql.includes('SELECT available')) return { rows: [{ available: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    withChatMeasurements(() =>
      reserveCredits(
        { client, schema: 'private_schema' },
        {
          id: 'private',
          flowId: 'private',
          modelId: 'fixture',
          agentId: null,
          activity: 'chat',
          providerPicoUsd: '1',
          pricingRevision: 'fixture',
        },
      ),
    ),
    CreditsExhausted,
  );
  assert.equal(inserted, false);
  assert.equal(records[0].operation, 'chat.detail.credit-account-lock');
});
