import { describe, expect, it, vi } from "vitest";
import type { ScheduleDispatcher } from "./dispatcher";
import {
  registerScheduleDispatch,
  SCHEDULE_DISPATCH_CRON,
  SCHEDULE_DISPATCH_QUEUE,
} from "./register";

type Handler = () => Promise<unknown>;

/** Records what a replica asked pg-boss for, and lets a test fire the registered worker. */
function fakeBoss() {
  const created: { name: string; options: unknown }[] = [];
  const scheduled: { name: string; cron: string }[] = [];
  const workers: { name: string; handler: Handler }[] = [];
  return {
    created,
    scheduled,
    workers,
    boss: {
      createQueue: async (name: string, options?: unknown) => {
        created.push({ name, options });
      },
      work: async (name: string, handler: Handler) => {
        workers.push({ name, handler });
        return name;
      },
      schedule: async (name: string, cron: string) => {
        scheduled.push({ name, cron });
      },
    },
  };
}

function fakeDispatcher(tick: () => Promise<void>): ScheduleDispatcher {
  return { tick } as unknown as ScheduleDispatcher;
}

describe("registerScheduleDispatch", () => {
  it("schedules the dispatch in Postgres instead of a per-process timer", async () => {
    const { boss, created, scheduled, workers } = fakeBoss();

    await registerScheduleDispatch(
      boss as never,
      fakeDispatcher(async () => {})
    );

    expect(created).toEqual([{ name: SCHEDULE_DISPATCH_QUEUE, options: { policy: "exclusive" } }]);
    expect(scheduled).toEqual([{ name: SCHEDULE_DISPATCH_QUEUE, cron: SCHEDULE_DISPATCH_CRON }]);
    expect(workers).toHaveLength(1);
  });

  it("uses the exclusive policy so a slow tick cannot stack a backlog behind it", async () => {
    // The cross-replica replacement for the old in-process `running` flag.
    const { boss, created } = fakeBoss();

    await registerScheduleDispatch(
      boss as never,
      fakeDispatcher(async () => {})
    );

    expect((created[0]?.options as { policy: string })?.policy).toBe("exclusive");
  });

  it("registers no process-local timer, so replicas cannot each fire the same Routine", async () => {
    const { boss } = fakeBoss();
    const setInterval = vi.spyOn(globalThis, "setInterval");

    await registerScheduleDispatch(
      boss as never,
      fakeDispatcher(async () => {})
    );

    expect(setInterval).not.toHaveBeenCalled();
    setInterval.mockRestore();
  });

  it("runs the dispatcher when the scheduled job fires", async () => {
    const tick = vi.fn(async () => {});
    const { boss, workers } = fakeBoss();
    await registerScheduleDispatch(boss as never, fakeDispatcher(tick));

    await workers[0]?.handler();

    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("logs a failed tick and does not rethrow, so pg-boss will not re-dispatch it", async () => {
    // A retry would re-send Routines the failed tick had already dispatched.
    const error = new Error("dispatch exploded");
    const log = { error: vi.fn() };
    const { boss, workers } = fakeBoss();
    await registerScheduleDispatch(
      boss as never,
      fakeDispatcher(async () => {
        throw error;
      }),
      { log }
    );

    await expect(workers[0]?.handler()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ error }, "routine schedule dispatch failed");
  });
});
