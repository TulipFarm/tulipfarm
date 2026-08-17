import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import {
  CURATOR_SWEEP_CRON,
  CURATOR_SWEEP_QUEUE,
  registerCuratorSweepSchedule,
} from "./sweep-schedule";

function fakeBoss(unschedule = vi.fn(async () => {})) {
  const createQueue = vi.fn(async () => {});
  const schedule = vi.fn(async () => {});
  return {
    createQueue,
    schedule,
    unschedule,
    boss: { createQueue, schedule, unschedule } as unknown as PgBoss,
  };
}

describe("registerCuratorSweepSchedule", () => {
  it("publishes the five-minute tick the Worker consumer listens on", async () => {
    const { boss, createQueue, schedule } = fakeBoss();

    await registerCuratorSweepSchedule(boss);

    expect(createQueue).toHaveBeenCalledWith(CURATOR_SWEEP_QUEUE);
    expect(schedule).toHaveBeenCalledWith(CURATOR_SWEEP_QUEUE, CURATOR_SWEEP_CRON);
  });

  it("names the queue the Worker's job consumer registers", () => {
    // The two halves are separate processes, so the contract is a plain string with no compiler
    // between them. A rename on one side alone silently stops every Task and Curator Run.
    expect(CURATOR_SWEEP_QUEUE).toBe("curator-sweep");
    expect(CURATOR_SWEEP_CRON).toBe("*/5 * * * *");
  });

  it("drops the retired task-reconcile schedule so an upgrade leaves no orphan tick", async () => {
    const { boss, unschedule } = fakeBoss();

    await registerCuratorSweepSchedule(boss);

    expect(unschedule).toHaveBeenCalledWith("task-reconcile");
  });

  it("boots even when the retired schedule cannot be dropped", async () => {
    // An instance that never ran the old queue has nothing to unschedule; pg-boss is free to
    // reject that, and a fresh install must not fail boot over a cleanup for a predecessor.
    const { boss, schedule } = fakeBoss(
      vi.fn(async () => Promise.reject(new Error("no such schedule")))
    );

    await expect(registerCuratorSweepSchedule(boss)).resolves.toBeUndefined();
    expect(schedule).toHaveBeenCalled();
  });
});
