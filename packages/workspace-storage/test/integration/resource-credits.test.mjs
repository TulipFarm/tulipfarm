import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import {
  chargeComputeSteps,
  chargeComputeWindow,
  chargeStorageDay,
  databaseBytes,
  finishComputeStep,
  runUnits,
  startComputeStep,
  storageDayUnits,
  storageMeasured,
} from '../../src/resource-credits.ts';
import { connect, fixture } from './fixture.mjs';

const gib = 1n << 30n;

test('storage and compute price by the month and the hour', () => {
  // One GiB for a full average month (30.4375 days) costs the monthly price.
  const day = storageDayUnits(gib, 23_000_000_000n, 150n);
  const month = 23_000_000_000n * 150n;
  assert.ok(month - (day * 304375n) / 10000n < 31n, 'daily charges add up to the monthly price, less rounding');
  assert.equal(runUnits(3_600_000n, 11_725_000_000n, 150n), 11_725_000_000n * 150n);
  assert.equal(runUnits(0n, 11_725_000_000n, 150n), 0n);
});

test('storage days, run steps and sandbox hours are each charged once', { timeout: 120000 }, async () => {
  const debits = [];
  await registerExtension(
    {
      name: 'recording-gate',
      register(slots) {
        slots.creditGate({
          async available() {
            return null;
          },
          async debit(_tx, units, entry) {
            debits.push([entry.activity, entry.id.replace(/:[^:]*$/, ''), units]);
          },
        });
      },
    },
    { app: 'worker', env: {} },
  );
  const db = await fixture();
  try {
    const workspace = await db.create();
    const runtime = await connect(db.login(workspace));
    const tx = { client: runtime, schema: workspace.names.schema };
    const run = async work => {
      await runtime.query('BEGIN');
      try {
        const result = await work();
        await runtime.query('COMMIT');
        return result;
      } catch (error) {
        await runtime.query('ROLLBACK');
        throw error;
      }
    };
    try {
      assert.ok((await run(() => databaseBytes(tx))) > 0n, 'a new workspace schema already uses some bytes');

      const day = { day: '2026-11-13', source: 'database', bytes: gib, units: 500n };
      assert.equal(await run(() => chargeStorageDay(tx, day)), true);
      assert.equal(await run(() => chargeStorageDay(tx, day)), false, 'a second worker charges the day once');
      assert.deepEqual([...(await run(() => storageMeasured(tx, '2026-11-13')))], ['database']);

      const start = new Date('2026-11-13T10:00:00Z');
      const step = (id, deadlineSeconds) => ({
        id,
        kind: 'workflow',
        subjectId: id,
        startedAt: start,
        deadline: new Date(start.getTime() + deadlineSeconds * 1000),
      });
      await run(() => startComputeStep(tx, step('finished', 600)));
      await run(() => startComputeStep(tx, step('finished', 600)));
      await run(() => startComputeStep(tx, step('lost', 120)));
      await run(() => startComputeStep(tx, step('running', 3600)));
      await run(() => finishComputeStep(tx, 'finished', new Date(start.getTime() + 60_000)));

      const now = new Date(start.getTime() + 300_000);
      const charged = await run(() => chargeComputeSteps(tx, now, ms => ms));
      assert.equal(charged, 180_000n, 'one finished minute plus a lost step charged to its two-minute deadline');
      assert.equal(await run(() => chargeComputeSteps(tx, now, ms => ms)), 0n, 'charged steps are not charged again');

      const hour = { windowStart: '2026-11-13T10:00:00Z', units: 700n };
      assert.equal(await run(() => chargeComputeWindow(tx, hour)), true);
      assert.equal(await run(() => chargeComputeWindow(tx, hour)), false);
      assert.equal(
        await run(() => chargeComputeWindow(tx, { ...hour, windowStart: '2026-11-13T11:00:00Z', units: 0n })),
        true,
      );

      assert.deepEqual(debits, [
        ['storage', 'storage:database', 500n],
        ['compute', 'compute:runs', 180_000n],
        ['compute', 'compute:sandbox:2026-11-13T10:00', 700n],
      ]);
    } finally {
      await runtime.end();
    }
  } finally {
    resetExtensions();
    await db.close();
  }
});
