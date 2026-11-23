import { z } from 'zod';
import type { CreditBalance } from '@tulipfarm/extensions';
import { commonCompatibility } from './runtime.ts';
import { qualified } from './names.ts';
import type { SqlClient } from './transactions.ts';

type Transaction = { client: SqlClient; schema: string };

/** The first common schema version with `tf_credit_alerts`. */
export const creditAlertCompatibility = Object.freeze({ minimum: 108, maximum: commonCompatibility.maximum });

export const creditAlertLevels = ['low', 'grace', 'stopped'] as const;
export type CreditAlertLevel = (typeof creditAlertLevels)[number];

const rank = (level: CreditAlertLevel | null) => (level ? creditAlertLevels.indexOf(level) + 1 : 0);

/**
 * The alert a balance has reached: `stopped` once nothing is spendable (balance plus grace), `grace` once the true
 * balance is zero or less, `low` once 10% or less of the granted credits are left, otherwise null.
 */
export function creditAlertLevel(balance: CreditBalance): CreditAlertLevel | null {
  if (balance.available + (balance.grace ?? 0n) <= 0n) return 'stopped';
  if (balance.available <= 0n) return 'grace';
  if (balance.granted !== null && balance.granted > 0n && balance.available * 10n <= balance.granted) return 'low';
  return null;
}

/**
 * Locks the workspace's alert state and records `level`. Returns `level` when it is above the last one recorded, so
 * the caller sends that alert inside the same transaction; a lower level re-arms the levels above it.
 */
export async function advanceCreditAlert(tx: Transaction, level: CreditAlertLevel | null) {
  const alerts = qualified(tx.schema, 'tf_credit_alerts');
  await tx.client.query(`INSERT INTO ${alerts} (id, level) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING`);
  const { rows } = await tx.client.query(`SELECT level FROM ${alerts} WHERE id = 1 FOR UPDATE`);
  const previous = z.object({ level: z.enum(creditAlertLevels).nullable() }).parse(rows[0]).level;
  if (previous === level) return null;
  await tx.client.query(`UPDATE ${alerts} SET level = $1, changed_at = clock_timestamp() WHERE id = 1`, [level]);
  return rank(level) > rank(previous) ? level : null;
}

/** User ids of the workspace's current admins. */
export async function workspaceAdmins(tx: Transaction) {
  const { rows } = await tx.client.query(
    `SELECT user_id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE role = 'admin' AND removed_at IS NULL ORDER BY created_at LIMIT 100`,
  );
  return z
    .array(z.object({ user_id: z.string() }))
    .parse(rows)
    .map(row => row.user_id);
}
