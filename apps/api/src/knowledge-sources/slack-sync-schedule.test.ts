import { describe, expect, it, vi } from "vitest";
import {
  retireSlackKnowledgeSyncSchedule,
  SLACK_KNOWLEDGE_SYNC_QUEUE,
} from "./slack-sync-schedule";

describe("retireSlackKnowledgeSyncSchedule", () => {
  it("unschedules the queue on every boot, including already-retired schedules", async () => {
    const unschedule = vi.fn(async () => {});
    await retireSlackKnowledgeSyncSchedule({ unschedule });
    await retireSlackKnowledgeSyncSchedule({ unschedule });
    expect(unschedule).toHaveBeenCalledTimes(2);
    expect(unschedule).toHaveBeenCalledWith(SLACK_KNOWLEDGE_SYNC_QUEUE);
  });

  it("surfaces cleanup failures so a persisted schedule is not silently left running", async () => {
    const unschedule = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    await expect(retireSlackKnowledgeSyncSchedule({ unschedule })).rejects.toThrow(
      "database unavailable"
    );
  });
});
