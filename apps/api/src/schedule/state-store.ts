import type { Queryable } from "../db";

/** Durable fire-state for one `x-triggers` entry. */
export interface RoutineScheduleStateRow {
  readonly routineSlug: string;
  readonly triggerIndex: number;
  readonly dedupKey: string;
  readonly lastScheduledForMs: number | null;
  readonly nextDueAtMs: number | null;
}

export class RoutineScheduleStateStore {
  constructor(private readonly db: Queryable) {}

  async listForBusiness(businessId: string): Promise<RoutineScheduleStateRow[]> {
    const result = await this.db.query(
      `SELECT routine_slug, trigger_index, dedup_key, last_scheduled_for_ms, next_due_at_ms
       FROM routine_schedule_state WHERE business_id = $1`,
      [businessId]
    );
    return result.rows.map((row) => ({
      routineSlug: String(row.routine_slug),
      triggerIndex: Number(row.trigger_index),
      dedupKey: String(row.dedup_key),
      lastScheduledForMs:
        row.last_scheduled_for_ms === null ? null : Number(row.last_scheduled_for_ms),
      nextDueAtMs: row.next_due_at_ms === null ? null : Number(row.next_due_at_ms),
    }));
  }

  async upsert(
    businessId: string,
    row: {
      readonly routineSlug: string;
      readonly triggerIndex: number;
      readonly dedupKey: string;
      readonly lastScheduledForMs: number | null;
      readonly nextDueAtMs: number | null;
    }
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO routine_schedule_state
         (business_id, routine_slug, trigger_index, dedup_key, last_scheduled_for_ms, next_due_at_ms, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (business_id, routine_slug, trigger_index)
       DO UPDATE SET
         dedup_key = EXCLUDED.dedup_key,
         last_scheduled_for_ms = EXCLUDED.last_scheduled_for_ms,
         next_due_at_ms = EXCLUDED.next_due_at_ms,
         updated_at = now()`,
      [
        businessId,
        row.routineSlug,
        row.triggerIndex,
        row.dedupKey,
        row.lastScheduledForMs,
        row.nextDueAtMs,
      ]
    );
  }

  /** Drop state rows for triggers missing from the caller's `listForBusiness` read. */
  async pruneMissing(
    businessId: string,
    stillLive: ReadonlyArray<{ readonly routineSlug: string; readonly triggerIndex: number }>,
    existing: readonly RoutineScheduleStateRow[]
  ): Promise<void> {
    const liveKeys = new Set(stillLive.map((t) => `${t.routineSlug}:${t.triggerIndex}`));
    const stale = existing.filter((row) => !liveKeys.has(`${row.routineSlug}:${row.triggerIndex}`));
    for (const row of stale) {
      await this.db.query(
        "DELETE FROM routine_schedule_state WHERE business_id = $1 AND routine_slug = $2 AND trigger_index = $3",
        [businessId, row.routineSlug, row.triggerIndex]
      );
    }
  }
}
