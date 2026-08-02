import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./db";

import { jobBossOptions, OBS_PRUNE_QUEUE, startJobConsumers } from "./job-consumers";

describe("startJobConsumers", () => {
  it("attaches without migrations and registers observability pruning", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "expired" }] }));
    const database = { query } as Queryable;
    const now = new Date("2026-08-01T12:00:00.000Z");
    const boss = {
      start: vi.fn(async () => {}),
      createQueue: vi.fn(async () => {}),
      work: vi.fn(
        async (_name: string, _handler: (jobs: unknown[]) => Promise<void>) => "worker-id"
      ),
    };

    await startJobConsumers({
      databaseUrl: "postgres://database/tulipfarm",
      database,
      now: () => now,
      boss: boss as unknown as PgBoss,
    });

    expect(jobBossOptions("postgres://database/tulipfarm")).toEqual({
      connectionString: "postgres://database/tulipfarm",
      migrate: false,
    });
    expect(boss.start).toHaveBeenCalledOnce();
    expect(boss.createQueue).toHaveBeenCalledWith(OBS_PRUNE_QUEUE);
    const handler = boss.work.mock.calls[0]?.[1];
    expect(handler).toBeDefined();
    await handler?.([{ data: { retentionMs: 60_000 } }]);
    expect(query).toHaveBeenCalledWith("DELETE FROM obs_event WHERE ts < $1 RETURNING id", [
      new Date(now.getTime() - 60_000),
    ]);
  });
});
