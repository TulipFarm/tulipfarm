import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { storageDayUnits } from '@tulipfarm/workspace-storage/resource-credits';
import { browserPicoUsdPerHour, createResourceBilling, objectWorkspace } from '../dist/resource-billing.js';

afterEach(resetExtensions);

test('stored objects are attributed to the workspace in their key', () => {
  const ws = '6f1c0a52-35f4-4c4e-9a8e-0d3f1b2c4d5e';
  assert.equal(objectWorkspace(`${ws}/files/report.pdf`), ws);
  assert.equal(objectWorkspace(`workspaces/${ws}/soul.md`), ws);
  assert.equal(objectWorkspace(`apps/${ws}/bundle.js`), ws);
  assert.equal(objectWorkspace('releases/abc/index.html'), undefined);
  assert.equal(objectWorkspace('workspaces/not-a-workspace/x'), undefined);
  assert.equal(objectWorkspace(`other/${ws}/x`), undefined);
});

test('run compute and storage are charged at their own credit rates', async () => {
  const gib = 1n << 30n;
  const debits = [];
  await registerExtension(
    {
      name: 'resource-rates',
      register(slots) {
        slots.creditPricing({
          unitsPerPicoUsd: 100n,
          computeUnitsPerPicoUsd: 7n,
          storageUnitsPerPicoUsd: 3n,
          round: units => units,
        });
        slots.creditGate({
          async available() {
            return null;
          },
          async debit(_tx, units, entry) {
            debits.push([entry.activity, units]);
          },
        });
      },
    },
    { app: 'worker', env: {} },
  );
  // One workspace that ran for an hour and stores one GiB in its database.
  const client = {
    async query(sql) {
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('tf_compute_steps')) return { rows: [{ milliseconds: '3600000' }], rowCount: 1 };
      if (sql.includes('tf_browser_usage')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT source')) return { rows: [], rowCount: 0 };
      if (sql.includes('pg_total_relation_size')) return { rows: [{ bytes: gib.toString() }], rowCount: 1 };
      if (sql.startsWith('INSERT INTO')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const pricing = {
    runPicoUsdPerHour: 1000n,
    databasePicoUsdPerGibMonth: 23_000_000_000n,
    objectPicoUsdPerGibMonth: 0n,
  };
  const billing = createResourceBilling({
    runtime: { transaction: (_workspaceId, _compatibility, action) => action({ client, schema: 'ws' }) },
    discover: async after => (after ? [] : ['6f1c0a52-35f4-4c4e-9a8e-0d3f1b2c4d5e']),
    env: {},
    meter: { pricing },
  });
  await billing.meterCompute(new AbortController().signal);
  await billing.meterStorage(new AbortController().signal);
  assert.deepEqual(debits, [
    ['compute', 7000n],
    ['storage', storageDayUnits(gib, pricing.databasePicoUsdPerGibMonth, 3n)],
  ]);
});

test('browser time costs four run steps unless the meter prices it', () => {
  const pricing = { runPicoUsdPerHour: 1000n, databasePicoUsdPerGibMonth: 0n, objectPicoUsdPerGibMonth: 0n };
  assert.equal(browserPicoUsdPerHour(pricing), 4000n);
  assert.equal(browserPicoUsdPerHour({ ...pricing, browserPicoUsdPerHour: 2500n }), 2500n);
});

test('a closed browser session is charged in its own flow at the browser price', async () => {
  const charges = [];
  await registerExtension(
    {
      name: 'browser-rates',
      register(slots) {
        slots.creditPricing({ unitsPerPicoUsd: 100n, computeUnitsPerPicoUsd: 1n, round: units => units });
        slots.creditGate({
          async available() {
            return null;
          },
          async debit() {},
        });
      },
    },
    { app: 'worker', env: {} },
  );
  const client = {
    async query(sql, values) {
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('tf_compute_steps')) return { rows: [], rowCount: 0 };
      if (sql.includes('tf_browser_usage')) {
        const stretch = { session_id: 's', flow_id: 'chat-1', opened: '0', started: '0', minutes: '30' };
        return { rows: [stretch], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO')) {
        charges.push(values.slice(1, 5));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const billing = createResourceBilling({
    runtime: { transaction: (_workspaceId, _compatibility, action) => action({ client, schema: 'ws' }) },
    discover: async after => (after ? [] : ['6f1c0a52-35f4-4c4e-9a8e-0d3f1b2c4d5e']),
    env: {},
    meter: { pricing: { runPicoUsdPerHour: 1000n, databasePicoUsdPerGibMonth: 0n, objectPicoUsdPerGibMonth: 0n } },
  });
  await billing.meterCompute(new AbortController().signal);
  // Half an hour at four times the run price.
  assert.deepEqual(charges, [['chat-1', 'compute-browser', 'compute', '2000']]);
});
