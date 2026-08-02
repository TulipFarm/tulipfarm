import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { OBS_PRUNE_CRON, OBS_PRUNE_QUEUE, registerObsPruneSchedule } from "./prune-schedule";

describe("registerObsPruneSchedule", () => {
  it("publishes the configured retention without registering a consumer", async () => {
    const createQueue = vi.fn(async () => {});
    const schedule = vi.fn(async () => {});
    const boss = { createQueue, schedule } as unknown as PgBoss;

    await registerObsPruneSchedule(boss, 42_000);

    expect(createQueue).toHaveBeenCalledWith(OBS_PRUNE_QUEUE);
    expect(schedule).toHaveBeenCalledWith(OBS_PRUNE_QUEUE, OBS_PRUNE_CRON, {
      retentionMs: 42_000,
    });
  });
});
