import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { creditSummary } from '../../src/credits.ts';
import { provisionWorkspace, qualified } from '../../src/provisioning.ts';
import { connect, fixture } from './fixture.mjs';

const credit = 1_000_000_000_000n;
const balanceTable = schema => qualified(schema, 'tf_test_gate_balance');

// A gate that keeps its own per-workspace balance, created when TulipFarm provisions the workspace.
const gate = {
  async available(tx) {
    return BigInt(
      (await tx.client.query(`SELECT available::text FROM ${balanceTable(tx.schema)} WHERE id=1`)).rows[0].available,
    );
  },
  async debit(tx, units) {
    await tx.client.query(`UPDATE ${balanceTable(tx.schema)} SET available=available-$1 WHERE id=1`, [
      units.toString(),
    ]);
  },
  async provision(tx) {
    await tx.client.query(
      `CREATE TABLE IF NOT EXISTS ${balanceTable(tx.schema)} (id integer PRIMARY KEY CHECK (id = 1), available numeric(30,0) NOT NULL, granted numeric(30,0) NOT NULL)`,
    );
    await tx.client.query(`INSERT INTO ${balanceTable(tx.schema)} VALUES (1, $1, $1) ON CONFLICT (id) DO NOTHING`, [
      (7n * credit).toString(),
    ]);
    await tx.client.query(`REVOKE ALL ON ${balanceTable(tx.schema)} FROM PUBLIC`);
    await tx.client.query(
      `GRANT SELECT, UPDATE(available) ON ${balanceTable(tx.schema)} TO ${escapeIdentifier(`${tx.schema}_runtime`)}`,
    );
  },
  async balance(tx) {
    const row = (
      await tx.client.query(`SELECT available::text, granted::text FROM ${balanceTable(tx.schema)} WHERE id=1`)
    ).rows[0];
    return { available: BigInt(row.available), granted: BigInt(row.granted) };
  },
};

async function summary(db, workspace) {
  const runtime = await connect(db.login(workspace));
  try {
    await runtime.query('BEGIN');
    const result = await creditSummary({ client: runtime, schema: workspace.names.schema }, { kind: 'workspace' });
    await runtime.query('ROLLBACK');
    return result;
  } finally {
    await runtime.end();
  }
}

test('a credit gate provisions per-workspace state and reports the summary balance', { timeout: 120000 }, async () => {
  const db = await fixture();
  try {
    const plain = await db.create();
    assert.deepEqual(
      [(await summary(db, plain)).available, (await summary(db, plain)).granted],
      [null, null],
      'the default gate is unlimited',
    );

    await registerExtension(
      {
        name: 'test-billing',
        register(slots) {
          slots.creditGate(gate);
        },
      },
      { app: 'storage-worker', env: {} },
    );
    const billed = await db.create();
    assert.equal(
      (await db.platform.query('SELECT to_regclass($1) IS NOT NULL AS present', [balanceTable(billed.names.schema)]))
        .rows[0].present,
      true,
    );
    await db.platform.query(`UPDATE ${balanceTable(billed.names.schema)} SET available=$1 WHERE id=1`, [
      (5n * credit).toString(),
    ]);
    await provisionWorkspace({
      connectionString: db.connectionString,
      workspaceId: billed.id,
      passwords: billed.passwords,
      initialAdmin: { userId: billed.userId, membershipId: billed.membershipId },
      migrations: db.baseline,
    });
    const result = await summary(db, billed);
    assert.deepEqual([result.available, result.granted], [5, 7], 'provisioning again keeps the balance');

    resetExtensions();
    await registerExtension(
      {
        name: 'available-only',
        register(slots) {
          slots.creditGate({ available: gate.available, debit: gate.debit });
        },
      },
      { app: 'api', env: {} },
    );
    const fallback = await summary(db, billed);
    assert.deepEqual(
      [fallback.available, fallback.granted],
      [5, null],
      'without balance() the summary shows available() only',
    );
  } finally {
    resetExtensions();
    await db.close();
  }
});
