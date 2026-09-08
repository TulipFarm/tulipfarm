import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { auditPersistedSchedules } from "./audit";

function fakeBoss(schedules: { name: string }[]) {
  return { getSchedules: vi.fn(async () => schedules) } as unknown as PgBoss;
}

function fakeLog() {
  return { error: vi.fn() };
}

describe("auditPersistedSchedules", () => {
  it("logs nothing when every persisted schedule is still actively registered", async () => {
    const boss = fakeBoss([{ name: "curator-sweep" }, { name: "obs-event-prune" }]);
    const log = fakeLog();

    await auditPersistedSchedules(boss, ["curator-sweep", "obs-event-prune"], log);

    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs loudly for a schedule no longer among the active queue names", async () => {
    // This is exactly issue #750: registerSlackKnowledgeSync stopped running, but nothing
    // unscheduled the queue it had persisted, so pg-boss kept enqueuing into it forever.
    const boss = fakeBoss([{ name: "curator-sweep" }, { name: "slack-knowledge-sync" }]);
    const log = fakeLog();

    await auditPersistedSchedules(boss, ["curator-sweep"], log);

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toEqual({ queue: "slack-knowledge-sync" });
    expect(log.error.mock.calls[0]?.[1]).toContain("slack-knowledge-sync");
  });

  it("does not block boot when the audit itself fails", async () => {
    const boss = {
      getSchedules: vi.fn(async () => Promise.reject(new Error("db unavailable"))),
    } as unknown as PgBoss;
    const log = fakeLog();

    await expect(auditPersistedSchedules(boss, [], log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
