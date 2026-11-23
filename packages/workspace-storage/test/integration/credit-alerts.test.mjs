import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceCreditAlert, creditAlertLevel, workspaceAdmins } from '../../src/credit-alerts.ts';
import { connect, fixture } from './fixture.mjs';

const credit = 1_000_000_000_000n;
const balance = (available, grace = 2n) => ({
  available: available * credit,
  granted: 100n * credit,
  grace: grace * credit,
});

test('credit alert levels follow the true balance, grace and granted credits', () => {
  assert.equal(creditAlertLevel(balance(11n)), null);
  assert.equal(creditAlertLevel(balance(10n)), 'low', '90% of granted credits used');
  assert.equal(creditAlertLevel(balance(0n)), 'grace');
  assert.equal(creditAlertLevel(balance(-1n)), 'grace');
  assert.equal(creditAlertLevel(balance(-2n)), 'stopped', 'nothing spendable once grace is used up');
  assert.equal(creditAlertLevel({ available: 0n, granted: null, grace: null }), 'stopped');
  assert.equal(creditAlertLevel({ available: 1n, granted: null }), null, 'no low alert without granted credits');
});

test('each credit alert is sent once per crossing and re-arms after a top-up', { timeout: 120000 }, async () => {
  const db = await fixture();
  try {
    const workspace = await db.create();
    const runtime = await connect(db.login(workspace));
    const tx = { client: runtime, schema: workspace.names.schema };
    const advance = async available => {
      await runtime.query('BEGIN');
      try {
        const level = await advanceCreditAlert(tx, creditAlertLevel(balance(available)));
        await runtime.query('COMMIT');
        return level;
      } catch (error) {
        await runtime.query('ROLLBACK');
        throw error;
      }
    };
    try {
      assert.equal(await advance(50n), null);
      assert.equal(await advance(10n), 'low');
      assert.equal(await advance(5n), null, 'a repeat check does not send low again');
      assert.equal(await advance(0n), 'grace');
      assert.equal(await advance(-1n), null);
      assert.equal(await advance(-2n), 'stopped');
      assert.equal(await advance(-3n), null);
      assert.equal(await advance(40n), null, 'a top-up clears the level');
      assert.equal(await advance(8n), 'low', 'and re-arms it');
      assert.equal(await advance(40n), null);
      assert.equal(await advance(-2n), 'stopped', 'a skipped level sends only the highest');
      assert.equal(await advance(-1n), null, 'a partial top-up back into grace does not send grace again');

      assert.deepEqual(await workspaceAdmins(tx), [workspace.userId]);
    } finally {
      await runtime.end();
    }
  } finally {
    await db.close();
  }
});
