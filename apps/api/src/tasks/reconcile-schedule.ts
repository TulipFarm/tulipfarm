import type { PgBoss } from "pg-boss";

// Must match `TASK_RECONCILE_QUEUE` in `apps/worker/src/job-consumers.ts` — pg-boss queue names
// cross the process boundary as plain strings, the same split `OBS_PRUNE_QUEUE` already uses
// between `apps/api/src/observability/prune-schedule.ts` and the Worker's job consumers.
export const TASK_RECONCILE_QUEUE = "task-reconcile";

/** Frequent enough that a fixed setup gap surfaces within one Companion session, cheap enough
 * (a handful of DB reads plus at most eleven upserts per business) to run on a schedule rather
 * than on an event. No established reconciler cadence exists elsewhere to match. */
export const TASK_RECONCILE_CRON = "*/15 * * * *";

/**
 * Publishes the recurring task-reconciler tick. The API owns Soul Config and schedule
 * registration (`apps/api/src/schedule/register.ts`); the Worker owns the consumer that gathers
 * signals and upserts/closes Tasks.
 */
export async function registerTaskReconcileSchedule(boss: PgBoss): Promise<void> {
  await boss.createQueue(TASK_RECONCILE_QUEUE);
  await boss.schedule(TASK_RECONCILE_QUEUE, TASK_RECONCILE_CRON);
}
