import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { chargeCredits, creditSummary } from '../../src/credits.ts';
import { connect, fixture } from './fixture.mjs';

const appId = '6f1c0a52-35f4-4c4e-9a8e-0d3f1b2c4d5e';
const buildId = '0b9e7d16-8a43-4f0e-b2d1-6c5a4e3f2a10';

test('app build and app hosting charges are debited once and summarized by activity', { timeout: 120000 }, async () => {
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
            debits.push([entry.id, entry.activity, units]);
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
    try {
      const tx = { client: runtime, schema: workspace.names.schema };
      await runtime.query('BEGIN');
      const hosting = { id: `app-hosting:${appId}:2026-11-13T10`, flowId: `app:${appId}`, activity: 'app-hosting' };
      const build = { id: `app-build:${buildId}`, flowId: `app:${appId}`, activity: 'app-build' };
      assert.equal(await chargeCredits(tx, { ...hosting, units: 150n }), true);
      assert.equal(await chargeCredits(tx, { ...build, units: 300n }), true);
      assert.equal(await chargeCredits(tx, { ...hosting, units: 150n }), false, 'a repeated charge is not debited');
      await runtime.query('COMMIT');

      await runtime.query('BEGIN');
      const summary = await creditSummary(tx, { kind: 'workspace' });
      await runtime.query('ROLLBACK');

      assert.deepEqual(debits, [
        [`app-hosting:${appId}:2026-11-13T10`, 'app-hosting', 150n],
        [`app-build:${buildId}`, 'app-build', 300n],
      ]);
      assert.deepEqual(summary.breakdown, [
        { modelId: 'app-build', agentId: null, activity: 'app-build', credits: 3e-10, calls: 1 },
        { modelId: 'app-hosting', agentId: null, activity: 'app-hosting', credits: 1.5e-10, calls: 1 },
      ]);
      assert.deepEqual(
        summary.series.map(({ activity, credits, calls }) => ({ activity, credits, calls })),
        [
          { activity: 'app-build', credits: 3e-10, calls: 1 },
          { activity: 'app-hosting', credits: 1.5e-10, calls: 1 },
        ],
      );
      assert.equal(summary.used, 4.5e-10);
      assert.equal(summary.held, 0);
    } finally {
      await runtime.end();
    }
  } finally {
    resetExtensions();
    await db.close();
  }
});
