import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chargeCredits, lockCredits } from './credits.ts';
import { commonCompatibility } from './runtime.ts';
import { qualified } from './names.ts';
import type { SqlClient } from './transactions.ts';

type Transaction = { client: SqlClient; schema: string; commonVersion?: number };

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

/** The first common schema version with browser usage. */
export const browserUsageCompatibility = Object.freeze({ minimum: 112, maximum: commonCompatibility.maximum });
// A workspace still on an older schema has no browser usage to record or charge.
const lacksBrowserUsage = (tx: Transaction) => (tx.commonVersion ?? browserUsageCompatibility.minimum) < 112;

/**
 * Records that a browser session was used, with the times its host reported. The first use of a session opened at
 * `openedAt` needs the `flowId` it is charged to, and ends the stretch of any earlier opening of the same session; a
 * use without a flow, such as a person watching, only extends a session already recorded. A use after the session's
 * stretch was charged starts a new stretch in the same flow.
 */
export async function recordBrowserUsage(
  tx: Transaction,
  input: { sessionId: string; openedAt: Date; closesAt: Date; at: Date; flowId?: string | undefined },
) {
  if (lacksBrowserUsage(tx)) return;
  const usage = qualified(tx.schema, 'tf_browser_usage');
  const updated = await tx.client.query(
    `UPDATE ${usage}
     SET closes_at = CASE WHEN $3::timestamptz >= last_active_at THEN GREATEST(started_at, $4::timestamptz) ELSE closes_at END,
         last_active_at = GREATEST(last_active_at, $3::timestamptz)
     WHERE session_id = $1 AND opened_at = $2 AND ended_at IS NULL AND charged_at IS NULL`,
    [input.sessionId, input.openedAt, input.at, input.closesAt],
  );
  if (updated.rowCount) return;
  const { rows } = await tx.client.query(
    `SELECT flow_id, ended_at, ended_at >= $3::timestamptz AS stale FROM ${usage}
     WHERE session_id = $1 AND opened_at = $2 ORDER BY started_at DESC LIMIT 1`,
    [input.sessionId, input.openedAt, input.at],
  );
  const previous = z.object({ flow_id: z.string(), ended_at: z.date(), stale: z.boolean() }).optional().parse(rows[0]);
  if (previous?.stale) return;
  const flowId = previous?.flow_id ?? input.flowId;
  if (!flowId) return;
  const startedAt = previous?.ended_at ?? input.openedAt;
  if (!previous)
    await tx.client.query(
      `UPDATE ${usage} SET ended_at = GREATEST(started_at, LEAST(closes_at, $2::timestamptz))
       WHERE session_id = $1 AND opened_at < $2::timestamptz AND ended_at IS NULL AND charged_at IS NULL`,
      [input.sessionId, input.openedAt],
    );
  await tx.client.query(
    `INSERT INTO ${usage} (session_id, opened_at, started_at, flow_id, last_active_at, closes_at)
     VALUES ($1, $2, $3::timestamptz, $4, $5, GREATEST($3::timestamptz, $6::timestamptz)) ON CONFLICT DO NOTHING`,
    [input.sessionId, input.openedAt, startedAt, flowId, input.at, input.closesAt],
  );
}

/** Records that a browser session closed at `at`, or earlier if its host had already closed it unused. */
export async function endBrowserUsage(tx: Transaction, sessionId: string, at: Date) {
  if (lacksBrowserUsage(tx)) return;
  await tx.client.query(
    `UPDATE ${qualified(tx.schema, 'tf_browser_usage')} SET ended_at = GREATEST(started_at, LEAST(closes_at, $2::timestamptz))
     WHERE session_id = $1 AND ended_at IS NULL AND charged_at IS NULL`,
    [sessionId, at],
  );
}

/**
 * Charges every browser stretch that ended, or whose host closed it unused, in its own flow, rounded up to whole
 * minutes. Each stretch is charged once. Returns the units charged.
 */
export async function chargeBrowserUsage(tx: Transaction, now: Date, unitsFor: (milliseconds: bigint) => bigint) {
  if (lacksBrowserUsage(tx)) return 0n;
  await lockCredits(tx);
  const { rows } = await tx.client.query(
    `UPDATE ${qualified(tx.schema, 'tf_browser_usage')}
     SET ended_at = COALESCE(ended_at, closes_at), charged_at = $1::timestamptz
     WHERE charged_at IS NULL AND (ended_at IS NOT NULL OR closes_at <= $1::timestamptz)
     RETURNING session_id::text, flow_id,
       floor(extract(epoch FROM opened_at) * 1000)::bigint::text AS opened,
       floor(extract(epoch FROM started_at) * 1000)::bigint::text AS started,
       ceil(extract(epoch FROM (ended_at - started_at)) / 60)::bigint::text AS minutes`,
    [now],
  );
  const stretch = z.object({
    session_id: z.string(),
    flow_id: z.string(),
    opened: z.string(),
    started: z.string(),
    minutes: z.string(),
  });
  let total = 0n;
  for (const row of rows.map(value => stretch.parse(value))) {
    // A stretch shorter than a minute is charged as one.
    const minutes = BigInt(row.minutes) > 0n ? BigInt(row.minutes) : 1n;
    const units = unitsFor(minutes * 60_000n);
    if (units <= 0n) continue;
    await chargeCredits(tx, {
      id: `browser:${row.session_id}:${row.opened}:${row.started}`,
      flowId: row.flow_id,
      activity: 'compute',
      modelId: 'compute-browser',
      units,
    });
    total += units;
  }
  return total;
}
