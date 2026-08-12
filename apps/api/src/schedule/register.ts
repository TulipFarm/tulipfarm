import type { PgBoss } from "pg-boss";
import type { ScheduleDispatcher } from "./dispatcher";

/** Cron granularity is per-minute; a slower poll would blur "every hour at :00" by its own gap. */
export const SCHEDULE_DISPATCH_INTERVAL_MS = 60 * 1000;

export const SCHEDULE_DISPATCH_QUEUE = "routine-schedule-dispatch";

/** Every minute, matching {@link SCHEDULE_DISPATCH_INTERVAL_MS}. */
export const SCHEDULE_DISPATCH_CRON = "* * * * *";

export interface RegisterScheduleDispatchOptions {
  log?: { error(obj: unknown, msg?: string): void };
}

/**
 * Registers the periodic `cron`/`interval`/`datetime` Routine trigger dispatch.
 *
 * This used to be a bare `setInterval` in every API process. That is correct on one replica and
 * silently wrong on more than one: each replica keeps its own timer, so a Routine scheduled for
 * 09:00 fires once per replica. The in-process `running` flag stopped a *slow* tick overlapping
 * itself, but nothing coordinated across processes.
 *
 * pg-boss already supplies the missing coordination — it is the same mechanism the five existing
 * scheduled queues use, and it needs no extension. (`pg_cron` would have been the obvious
 * alternative, but it is superuser-only, single-database, and absent from the shipped image, so
 * adopting it would cost the "point `DATABASE_URL` at any Postgres" property.) The cron entry
 * lives in Postgres, so exactly one replica claims each tick.
 *
 * The `exclusive` policy is the cross-replica replacement for the old `running` flag: at most one
 * dispatch job exists queued or active at a time, so a tick running longer than a minute delays
 * the next one instead of stacking a backlog behind it.
 */
export async function registerScheduleDispatch(
  boss: PgBoss,
  dispatcher: ScheduleDispatcher,
  opts: RegisterScheduleDispatchOptions = {}
): Promise<void> {
  await boss.createQueue(SCHEDULE_DISPATCH_QUEUE, { policy: "exclusive" });
  await boss.work(SCHEDULE_DISPATCH_QUEUE, async () => {
    try {
      await dispatcher.tick();
    } catch (error) {
      opts.log?.error({ error }, "routine schedule dispatch failed");
      // Swallowed deliberately rather than rethrown: pg-boss would retry, but the next cron tick
      // is only a minute away and would re-dispatch whatever the failed tick had already sent.
    }
  });
  await boss.schedule(SCHEDULE_DISPATCH_QUEUE, SCHEDULE_DISPATCH_CRON);
}
