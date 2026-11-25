import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { relationInstalled } from '@tulipfarm/workspace-storage/transaction-reads';

type Tx = AuthorizationTransaction;
const relation = (tx: Tx, name: string) => qualified(tx.schema, name);

/** Every workspace's task keys start with this prefix. */
export const taskKeyPrefix = 'TUL';
/** The welcome task's number. Real tasks start at 1. */
export const welcomeTaskNumber = 0;
/** The common storage version that adds task keys and reminders. */
export const taskKeysVersion = 114;
const maximumNumber = 2147483647;

/** TUL-000 … TUL-999, then TUL-1000 and up. */
export const formatTaskKey = (number: number) => `${taskKeyPrefix}-${String(number).padStart(3, '0')}`;

/** The number in a key such as `TUL-7`, `tul-007` or `TUL-1000`, or null when the text is not a key. */
export function parseTaskKey(text: string): number | null {
  const match = /^tul-(\d{1,10})$/i.exec(text.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return number <= maximumNumber ? number : null;
}

export const taskKeySchema = z.string().regex(/^TUL-\d{3,}$/);

export async function taskKeysReady(tx: Tx) {
  const version = (tx as { commonVersion?: number }).commonVersion;
  if (version !== undefined) return version >= taskKeysVersion;
  return relationInstalled(tx.client, relation(tx, 'tf_task_keys'));
}

/** Gives a new task the next number, once. Numbers are never reused, even after the task is deleted. */
export async function allocateTaskKey(tx: Tx, tableId: string, rowId: string) {
  if (!(await taskKeysReady(tx))) return null;
  const existing = await taskNumberOf(tx, tableId, rowId);
  if (existing !== null) return existing;
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_task_key_counters')}(table_id,next_number) VALUES($1,1) ON CONFLICT DO NOTHING`,
    [tableId],
  );
  const number = z
    .number()
    .int()
    .parse(
      (
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_task_key_counters')} SET next_number=next_number+1 WHERE table_id=$1 RETURNING next_number-1 AS number`,
          [tableId],
        )
      ).rows[0]?.number,
    );
  await tx.client.query(`INSERT INTO ${relation(tx, 'tf_task_keys')}(table_id,row_id,number) VALUES($1,$2,$3)`, [
    tableId,
    rowId,
    number,
  ]);
  return number;
}

export async function taskNumberOf(tx: Tx, tableId: string, rowId: string) {
  if (!(await taskKeysReady(tx))) return null;
  const row = (
    await tx.client.query(`SELECT number FROM ${relation(tx, 'tf_task_keys')} WHERE table_id=$1 AND row_id=$2`, [
      tableId,
      rowId,
    ])
  ).rows[0];
  return row ? z.number().int().parse(row.number) : null;
}

/** The key of each listed task that has one. */
export async function taskKeysOf(tx: Tx, tableId: string, rowIds: readonly string[]) {
  const keys = new Map<string, string>();
  if (!rowIds.length || !(await taskKeysReady(tx))) return keys;
  const rows = (
    await tx.client.query(
      `SELECT row_id,number FROM ${relation(tx, 'tf_task_keys')} WHERE table_id=$1 AND row_id=ANY($2::uuid[])`,
      [tableId, rowIds],
    )
  ).rows;
  for (const row of rows) keys.set(String(row.row_id), formatTaskKey(Number(row.number)));
  return keys;
}

/** Every task key in the table, by row. */
export async function allTaskKeys(tx: Tx, tableId: string) {
  if (!(await taskKeysReady(tx))) return [];
  return (
    await tx.client.query(
      `SELECT row_id,number FROM ${relation(tx, 'tf_task_keys')} WHERE table_id=$1 ORDER BY number LIMIT 100000`,
      [tableId],
    )
  ).rows.map(row => ({
    rowId: String(row.row_id),
    number: Number(row.number),
    key: formatTaskKey(Number(row.number)),
  }));
}

/** The row a task number names, or null. */
export async function rowOfTaskNumber(tx: Tx, tableId: string, number: number) {
  if (!(await taskKeysReady(tx))) return null;
  const row = (
    await tx.client.query(`SELECT row_id FROM ${relation(tx, 'tf_task_keys')} WHERE table_id=$1 AND number=$2`, [
      tableId,
      number,
    ])
  ).rows[0];
  return row ? String(row.row_id) : null;
}
