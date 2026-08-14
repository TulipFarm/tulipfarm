import type { PgBoss } from "pg-boss";
import type { ScheduleDispatcher } from "./dispatcher";

export const SCHEDULE_DISPATCH_INTERVAL_MS = 60 * 1000;

export const SCHEDULE_DISPATCH_QUEUE = "routine-schedule-dispatch";

export const SCHEDULE_DISPATCH_CRON = "* * * * *";

export interface RegisterScheduleDispatchOptions {
  log?: { error(obj: unknown, msg?: string): void };
}

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
