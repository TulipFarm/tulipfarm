import type { PgBoss } from "pg-boss";

// Must match `CURATOR_SWEEP_QUEUE` in `apps/worker/src/job-consumers.ts`: pg-boss queue names
// cross the process boundary as plain strings, the same split `OBS_PRUNE_QUEUE` already uses.
export const CURATOR_SWEEP_QUEUE = "curator-sweep";

/** Five minutes because the Curator's fan-out shares this tick — the interval at which a finished
 * conversation becomes a learning, short enough to feel live, long enough to stay a few reads. */
export const CURATOR_SWEEP_CRON = "*/5 * * * *";

/**
 * Publishes the recurring sweep tick. The API owns Soul Config and schedule registration
 * (`apps/api/src/schedule/register.ts`); the Worker owns the consumer that reconciles Tasks and
 * then fans the Curator out over users with a backlog. The retired `task-reconcile` schedule is
 * dropped here so an upgraded instance stops enqueuing into a queue no Worker consumes.
 */
export async function registerCuratorSweepSchedule(boss: PgBoss): Promise<void> {
  await boss.createQueue(CURATOR_SWEEP_QUEUE);
  await boss.schedule(CURATOR_SWEEP_QUEUE, CURATOR_SWEEP_CRON);
  await boss.unschedule("task-reconcile").catch(() => {});
}

/**
 * Runs the out-of-band sweep kick, swallowing its failure: the caller's own work is already
 * committed, so a dead pg-boss must cost no more than a wait for the next cron tick. `trigger` is
 * absent wherever pg-boss is not wired; `because` names the event for the log line.
 */
export async function kickCuratorSweep(
  trigger: (() => Promise<void>) | undefined,
  log: { error(message: string): void },
  because: string
): Promise<void> {
  if (!trigger) return;
  try {
    await trigger();
  } catch (err) {
    log.error(
      `[curator] sweep kick after ${because} failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
