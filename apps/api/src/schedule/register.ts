import type { ScheduleDispatcher } from "./dispatcher";

/** Cron granularity is per-minute; a slower poll would blur "every hour at :00" by its own gap. */
export const SCHEDULE_DISPATCH_INTERVAL_MS = 60 * 1000;

export interface RegisterScheduleDispatchOptions {
  log?: { error(obj: unknown, msg?: string): void };
}

/**
 * Registers the periodic `cron`/`interval`/`datetime` Routine trigger dispatch in this process.
 * Always on — unlike Soul down-sync there is no remote to gate it on. Returns the interval so
 * shutdown can stop future ticks.
 */
export function registerScheduleDispatch(
  dispatcher: ScheduleDispatcher,
  opts: RegisterScheduleDispatchOptions = {}
): ReturnType<typeof setInterval> {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void dispatcher
      .tick()
      .catch((error: unknown) => {
        opts.log?.error({ error }, "routine schedule dispatch failed");
      })
      .finally(() => {
        running = false;
      });
  }, SCHEDULE_DISPATCH_INTERVAL_MS);
}
