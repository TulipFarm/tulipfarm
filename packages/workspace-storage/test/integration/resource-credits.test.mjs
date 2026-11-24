import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import {
  chargeBrowserUsage,
  chargeComputeSteps,
  chargeComputeWindow,
  chargeStorageDay,
  databaseBytes,
  endBrowserUsage,
  finishComputeStep,
  recordBrowserUsage,
  runUnits,
  startComputeStep,
  storageDayUnits,
  storageMeasured,
} from '../../src/resource-credits.ts';
import { reserveCredits, settleCredits } from '../../src/credits.ts';
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

test(
  'browser time is charged once per session in its flow, rounded up to whole minutes',
  { timeout: 120000 },
  async () => {
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
              debits.push([entry.id, units]);
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
      const at = seconds => new Date(Date.UTC(2026, 10, 13, 10) + seconds * 1000);
      const closed = '11111111-1111-4111-8111-111111111111';
      const unused = '22222222-2222-4222-8222-222222222222';
      const watched = '33333333-3333-4333-8333-333333333333';
      try {
        // A person watching a session the agent never recorded starts no charge.
        await run(() => recordBrowserUsage(tx, { sessionId: watched, openedAt: at(0), closesAt: at(600), at: at(5) }));
        // Closed after 61 seconds: two minutes in the run's flow.
        const run1 = { sessionId: closed, openedAt: at(0), flowId: 'flow-run' };
        await run(() => recordBrowserUsage(tx, { ...run1, closesAt: at(600), at: at(0) }));
        await run(() => recordBrowserUsage(tx, { ...run1, closesAt: at(630), at: at(30) }));
        await run(() => endBrowserUsage(tx, closed, at(61)));
        // Never closed explicitly: charged to the time the host closes it idle, once that time has passed.
        const chat = { sessionId: unused, openedAt: at(0), flowId: 'flow-chat' };
        await run(() => recordBrowserUsage(tx, { ...chat, closesAt: at(600), at: at(0) }));
        // A person's use extends the session without a flow of its own.
        await run(() => recordBrowserUsage(tx, { sessionId: unused, openedAt: at(0), closesAt: at(610), at: at(10) }));

        const minute = ms => ms / 60_000n;
        assert.equal(await run(() => chargeBrowserUsage(tx, at(300), minute)), 2n, 'only the closed session is due');
        assert.equal(
          await run(() => chargeBrowserUsage(tx, at(300), minute)),
          0n,
          'a charged session is not charged again',
        );
        assert.equal(
          await run(() => chargeBrowserUsage(tx, at(700), minute)),
          11n,
          '610 seconds round up to 11 minutes',
        );
        assert.equal(await run(() => chargeBrowserUsage(tx, at(900), minute)), 0n);

        // Use after the charge, such as a person finishing a sign-in, starts a new stretch in the same flow.
        await run(() =>
          recordBrowserUsage(tx, { sessionId: unused, openedAt: at(0), closesAt: at(1300), at: at(700) }),
        );
        await run(() => endBrowserUsage(tx, unused, at(620)));
        assert.equal(await run(() => chargeBrowserUsage(tx, at(900), minute)), 1n, 'a short stretch is a whole minute');

        const { rows } = await runtime.query(
          `SELECT flow_id, model_id, activity, charged::text FROM ${workspace.names.schema}.tf_credit_usage ORDER BY id`,
        );
        assert.deepEqual(
          rows.map(row => [row.flow_id, row.model_id, row.activity, row.charged]),
          [
            ['flow-run', 'compute-browser', 'compute', '2'],
            ['flow-chat', 'compute-browser', 'compute', '11'],
            ['flow-chat', 'compute-browser', 'compute', '1'],
          ],
        );
        assert.equal(debits.length, 3);
        assert.ok(debits.every(([id]) => id.startsWith('browser:')));

        // A model call in a flow with browser time is charged the same as in a flow without it.
        const settled = async (id, flowId) => {
          await run(() =>
            reserveCredits(tx, {
              id,
              flowId,
              modelId: 'model',
              agentId: null,
              activity: 'chat',
              providerPicoUsd: '5000000000',
              pricingRevision: 'test',
            }),
          );
          await run(() => settleCredits(tx, id, '5000000000'));
          return (
            await runtime.query(`SELECT charged::text FROM ${workspace.names.schema}.tf_credit_usage WHERE id=$1`, [id])
          ).rows[0].charged;
        };
        const charged = await settled('call-chat', 'flow-chat');
        assert.ok(BigInt(charged) > 0n);
        assert.equal(charged, await settled('call-fresh', 'flow-fresh'));
      } finally {
        await runtime.end();
      }
    } finally {
      resetExtensions();
      await db.close();
    }
  },
);
