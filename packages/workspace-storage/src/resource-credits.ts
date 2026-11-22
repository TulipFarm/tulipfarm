import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chargeCredits, lockCredits } from './credits.ts';
import { commonCompatibility } from './runtime.ts';
import { qualified } from './names.ts';
import type { SqlClient } from './transactions.ts';

type Transaction = { client: SqlClient; schema: string };

/** The first common schema version with the storage and compute tables. */
export const resourceCompatibility = Object.freeze({ minimum: 107, maximum: commonCompatibility.maximum });
export const storageSources = ['database', 'objects', 'apps'] as const;
export type StorageSource = (typeof storageSources)[number];

const gib = 1n << 30n;
// An average month, 30.4375 days, in seconds.
const monthSeconds = 2_629_800n;
const daySeconds = 86_400n;
const hourMs = 3_600_000n;

/** Credit units for keeping `bytes` stored for one day at a monthly price per GiB. */
export function storageDayUnits(bytes: bigint, picoUsdPerGibMonth: bigint, unitsPerPicoUsd: bigint) {
  return (bytes * picoUsdPerGibMonth * unitsPerPicoUsd * daySeconds) / (gib * monthSeconds);
}

/** Credit units for `milliseconds` of a run step at an hourly price. */
export function runUnits(milliseconds: bigint, picoUsdPerHour: bigint, unitsPerPicoUsd: bigint) {
  return (milliseconds * picoUsdPerHour * unitsPerPicoUsd) / hourMs;
}

/** Bytes the workspace schema's tables and materialized views use, with their indexes and TOAST. */
export async function databaseBytes(tx: Transaction) {
  const { rows } = await tx.client.query(
    `SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::text AS bytes
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'm')`,
    [tx.schema],
  );
  return BigInt(z.object({ bytes: z.string() }).parse(rows[0]).bytes);
}

/** Bytes of this workspace's app releases among `sizes`, a map of release id to bytes held for it. */
export async function releaseBytes(tx: Transaction, sizes: ReadonlyMap<string, bigint>) {
  if (!sizes.size) return 0n;
  const { rows } = await tx.client.query(
    `SELECT id::text FROM ${qualified(tx.schema, 'tf_app_releases')} WHERE id::text = ANY($1::text[])`,
    [[...sizes.keys()]],
  );
  return rows.reduce((sum, row) => sum + (sizes.get((row as { id: string }).id) ?? 0n), 0n);
}

/** Storage sources already measured and charged for `day` (YYYY-MM-DD, UTC). */
export async function storageMeasured(tx: Transaction, day: string) {
  const { rows } = await tx.client.query(
    `SELECT source FROM ${qualified(tx.schema, 'tf_storage_usage')} WHERE day = $1::date`,
    [day],
  );
  return new Set(rows.map(row => (row as { source: StorageSource }).source));
}

/**
 * Records one day's storage measurement for a source and charges it. Returns false when that day and source were
 * already charged, so a second worker or a retry charges once.
 */
export async function chargeStorageDay(
  tx: Transaction,
  input: { day: string; source: StorageSource; bytes: bigint; units: bigint },
) {
  await lockCredits(tx);
  const inserted = await tx.client.query(
    `INSERT INTO ${qualified(tx.schema, 'tf_storage_usage')} (day, source, bytes, units)
     VALUES ($1::date, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [input.day, input.source, input.bytes.toString(), input.units.toString()],
  );
  if (!inserted.rowCount) return false;
  if (input.units > 0n)
    await chargeCredits(tx, {
      id: `storage:${input.source}:${input.day}`,
      flowId: 'storage',
      activity: 'storage',
      modelId: `storage-${input.source}`,
      units: input.units,
    });
  return true;
}

/** Records that a run step started. A retried call for the same attempt keeps the first start. */
export async function startComputeStep(
  tx: Transaction,
  input: { id: string; kind: 'agent-task' | 'workflow'; subjectId: string; startedAt: Date; deadline: Date },
) {
  await tx.client.query(
    `INSERT INTO ${qualified(tx.schema, 'tf_compute_steps')} (id, kind, subject_id, started_at, deadline)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [input.id, input.kind, input.subjectId, input.startedAt, input.deadline],
  );
}

/** Records that a run step ended. Its time is charged later by `chargeComputeSteps`. */
export async function finishComputeStep(tx: Transaction, id: string, endedAt: Date) {
  await tx.client.query(
    `UPDATE ${qualified(tx.schema, 'tf_compute_steps')} SET ended_at = GREATEST(started_at, LEAST(deadline, $2))
     WHERE id = $1 AND ended_at IS NULL`,
    [id, endedAt],
  );
}

/**
 * Charges every run step that ended, or whose deadline passed without an end, as one compute charge. A step that
 * never recorded its end is charged up to its deadline. Returns the units charged.
 */
export async function chargeComputeSteps(tx: Transaction, now: Date, unitsFor: (milliseconds: bigint) => bigint) {
  await lockCredits(tx);
  const { rows } = await tx.client.query(
    `UPDATE ${qualified(tx.schema, 'tf_compute_steps')}
     SET ended_at = COALESCE(ended_at, deadline), charged_at = $1
     WHERE charged_at IS NULL AND (ended_at IS NOT NULL OR deadline <= $1)
     RETURNING floor(extract(epoch FROM (ended_at - started_at)) * 1000)::bigint::text AS milliseconds`,
    [now],
  );
  const milliseconds = rows.reduce((sum, row) => sum + BigInt((row as { milliseconds: string }).milliseconds), 0n);
  const units = unitsFor(milliseconds);
  if (units > 0n)
    await chargeCredits(tx, {
      id: `compute:runs:${randomUUID()}`,
      flowId: 'compute',
      activity: 'compute',
      modelId: 'compute-runs',
      units,
    });
  return units;
}

/** Charges a workspace's sandbox compute for one hour. Returns false when that hour was already charged. */
export async function chargeComputeWindow(tx: Transaction, input: { windowStart: string; units: bigint }) {
  await lockCredits(tx);
  const inserted = await tx.client.query(
    `INSERT INTO ${qualified(tx.schema, 'tf_compute_windows')} (window_start, source, units)
     VALUES ($1, 'sandbox', $2) ON CONFLICT DO NOTHING`,
    [input.windowStart, input.units.toString()],
  );
  if (!inserted.rowCount) return false;
  if (input.units > 0n)
    await chargeCredits(tx, {
      id: `compute:sandbox:${new Date(input.windowStart).toISOString()}`,
      flowId: 'compute',
      activity: 'compute',
      modelId: 'compute-sandbox',
      units: input.units,
    });
  return true;
}
