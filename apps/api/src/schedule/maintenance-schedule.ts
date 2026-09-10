import type { PgBoss } from "pg-boss";

// Must match `MAINTENANCE_SWEEP_QUEUE` in `apps/worker/src/job-consumers.ts`: pg-boss queue names
// cross the process boundary as plain strings, the same split `OBS_PRUNE_QUEUE` already uses.
export const MAINTENANCE_SWEEP_QUEUE = "maintenance-sweep";

/** Five minutes: the interval at which a setup gap the operator just closed stops being a Task. */
export const MAINTENANCE_SWEEP_CRON = "*/5 * * * *";

/**
 * Publishes the recurring maintenance tick. The API owns Soul Config and schedule registration;
 * the Worker owns the consumer that reconciles Tasks.
 *
 * The two retired schedules are dropped here rather than left to rot, so an upgraded instance
 * stops enqueuing into queues no Worker consumes.
 */
export async function registerMaintenanceSweepSchedule(boss: PgBoss): Promise<void> {
  await boss.createQueue(MAINTENANCE_SWEEP_QUEUE);
  await boss.schedule(MAINTENANCE_SWEEP_QUEUE, MAINTENANCE_SWEEP_CRON);
  await boss.unschedule("task-reconcile").catch(() => {});
  await boss.unschedule("curator-sweep").catch(() => {});
}

/**
 * Runs the out-of-band sweep kick, swallowing its failure: the caller's own work is already
 * committed, so a dead pg-boss must cost no more than a wait for the next cron tick. `trigger` is
 * absent wherever pg-boss is not wired; `because` names the event for the log line.
 */
export async function kickMaintenanceSweep(
  trigger: (() => Promise<void>) | undefined,
  log: { error(message: string): void },
  because: string
): Promise<void> {
  if (!trigger) return;
  try {
    await trigger();
  } catch (err) {
    log.error(
      `[maintenance] sweep kick after ${because} failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
