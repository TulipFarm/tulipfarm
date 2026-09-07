import type { Queryable } from "../db";

/** Durable fire-state for one embedded Routine Trigger. */
export interface RoutineScheduleStateRow {
  readonly routineSlug: string;
  readonly triggerId: string;
  /** Authored position is metadata only; Trigger identity owns the checkpoint. */
  readonly triggerIndex: number;
  readonly dedupKey: string;
  readonly lastScheduledForMs: number | null;
  readonly nextDueAtMs: number | null;
  /** Phase origin for an `interval` Trigger with no authored `schedule.startAt`. */
  readonly anchorMs: number | null;
}

export class RoutineScheduleStateStore {
  constructor(private readonly db: Queryable) {}

  async listForBusiness(businessId: string): Promise<RoutineScheduleStateRow[]> {
    const result = await this.db.query(
      `SELECT routine_slug, trigger_id, trigger_index, dedup_key, last_scheduled_for_ms, next_due_at_ms, anchor_ms
       FROM routine_schedule_state WHERE business_id = $1`,
      [businessId]
    );
    return result.rows.map((row) => ({
      routineSlug: String(row.routine_slug),
      triggerId: String(row.trigger_id),
      triggerIndex: Number(row.trigger_index),
      dedupKey: String(row.dedup_key),
      lastScheduledForMs:
        row.last_scheduled_for_ms === null ? null : Number(row.last_scheduled_for_ms),
      nextDueAtMs: row.next_due_at_ms === null ? null : Number(row.next_due_at_ms),
      anchorMs:
        row.anchor_ms === null || row.anchor_ms === undefined ? null : Number(row.anchor_ms),
    }));
  }

  async upsert(businessId: string, row: RoutineScheduleStateRow): Promise<void> {
    await this.db.query(
      `INSERT INTO routine_schedule_state
         (business_id, routine_slug, trigger_index, dedup_key, last_scheduled_for_ms, next_due_at_ms, anchor_ms, trigger_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (business_id, routine_slug, trigger_id)
       DO UPDATE SET
         trigger_index = EXCLUDED.trigger_index,
         dedup_key = EXCLUDED.dedup_key,
         last_scheduled_for_ms = EXCLUDED.last_scheduled_for_ms,
         next_due_at_ms = EXCLUDED.next_due_at_ms,
         anchor_ms = EXCLUDED.anchor_ms,
         updated_at = now()`,
      [
        businessId,
        row.routineSlug,
        row.triggerIndex,
        row.dedupKey,
        row.lastScheduledForMs,
        row.nextDueAtMs,
        row.anchorMs,
        row.triggerId,
      ]
    );
  }

  /** Drop state rows for triggers missing from the caller's `listForBusiness` read. */
  async pruneMissing(
    businessId: string,
    stillLive: ReadonlyArray<{ readonly routineSlug: string; readonly triggerId: string }>,
    existing: readonly RoutineScheduleStateRow[]
  ): Promise<void> {
    const liveKeys = new Set(stillLive.map((t) => `${t.routineSlug}:${t.triggerId}`));
    const stale = existing.filter((row) => !liveKeys.has(`${row.routineSlug}:${row.triggerId}`));
    for (const row of stale) {
      await this.db.query(
        "DELETE FROM routine_schedule_state WHERE business_id = $1 AND routine_slug = $2 AND trigger_id = $3",
        [businessId, row.routineSlug, row.triggerId]
      );
    }
  }
}
