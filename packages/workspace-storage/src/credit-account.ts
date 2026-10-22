import { z } from 'zod';
import { defineExtension, type CreditGate } from '@tulipfarm/extensions';
import { escapeIdentifier } from 'pg';
import { qualified, workspaceNames } from './names.ts';
import type { SqlClient } from './transactions.ts';

const units = z.string().regex(/^(0|[1-9]\d{0,29})$/);

/**
 * A test credit gate backed by a per-workspace tf_credit_account balance. TulipFarm never registers it:
 * its tests do, to exercise exhaustion. Credits are unlimited unless a billing extension registers a gate.
 */
export const creditAccountGate: CreditGate = {
  async available(tx, options) {
    const row = z
      .object({ available: units })
      .parse(
        (
          await tx.client.query(
            `SELECT available FROM ${qualified(tx.schema, 'tf_credit_account')} WHERE id=1${options?.lock ? ' FOR UPDATE' : ''}`,
          )
        ).rows[0],
      );
    return BigInt(row.available);
  },
  async debit(tx, amount) {
    await tx.client.query(`UPDATE ${qualified(tx.schema, 'tf_credit_account')} SET available=available-$1 WHERE id=1`, [
      amount.toString(),
    ]);
  },
  async balance(tx) {
    const row = z
      .object({ available: units, granted: units })
      .parse(
        (
          await tx.client.query(
            `SELECT available,granted FROM ${qualified(tx.schema, 'tf_credit_account')} WHERE id=1 FOR SHARE`,
          )
        ).rows[0],
      );
    return { available: BigInt(row.available), granted: BigInt(row.granted) };
  },
};

/** Creates the balance table this gate reads in one workspace schema. The common migrations never create it. */
export async function installCreditAccount(client: SqlClient, workspaceId: string, units = 1_000_000_000_000_000n) {
  const names = workspaceNames(workspaceId),
    account = qualified(names.schema, 'tf_credit_account');
  await client.query(`CREATE TABLE ${account} (
    id integer PRIMARY KEY CHECK (id = 1),
    available numeric(30,0) NOT NULL CHECK (available >= 0),
    granted numeric(30,0) NOT NULL CHECK (granted >= 0)
  )`);
  await client.query(`INSERT INTO ${account} VALUES (1, $1, $1)`, [units.toString()]);
  await client.query(`REVOKE ALL ON ${account} FROM PUBLIC`);
  await client.query(`GRANT SELECT, UPDATE(available) ON ${account} TO ${escapeIdentifier(names.runtime)}`);
}

export const creditAccountExtension = defineExtension({
  name: 'credit-account',
  register(slots) {
    slots.creditGate(creditAccountGate);
  },
});

export default creditAccountExtension;
