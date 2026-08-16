import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./db";

import {
  jobBossOptions,
  OBS_PRUNE_QUEUE,
  SOUL_BUNDLE_PRUNE_QUEUE,
  startJobConsumers,
} from "./job-consumers";

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

describe("published bundle retention consumer", () => {
  function bossDouble() {
    return {
      start: vi.fn(async () => {}),
      createQueue: vi.fn(async () => {}),
      work: vi.fn(
        async (_name: string, _handler: (jobs: unknown[]) => Promise<void>) => "worker-id"
      ),
      schedule: vi.fn(async () => {}),
    };
  }

  it("sweeps in bounded batches and reports the outcome", async () => {
    const boss = bossDouble();
    const deleteUnreferencedBundles = vi
      .fn<(input: { limit: number }) => Promise<number>>()
      .mockResolvedValueOnce(200)
      .mockResolvedValueOnce(7);
    const info = vi.fn();
    const now = new Date("2026-08-16T00:00:00.000Z");

    await startJobConsumers({
      databaseUrl: "postgres://database/tulipfarm",
      database: { query: vi.fn(async () => ({ rows: [] })) } as unknown as Queryable,
      now: () => now,
      boss: boss as unknown as PgBoss,
      businessId: "business-1",
      bundles: { deleteUnreferencedBundles },
      log: { error: vi.fn(), info },
    });

    expect(boss.createQueue).toHaveBeenCalledWith(SOUL_BUNDLE_PRUNE_QUEUE);
    const registration = boss.work.mock.calls.find(([name]) => name === SOUL_BUNDLE_PRUNE_QUEUE);
    await registration?.[1]([{ data: { retentionMs: 60_000 } }]);

    expect(deleteUnreferencedBundles).toHaveBeenCalledWith({
      businessId: "business-1",
      olderThan: new Date(now.getTime() - 60_000).toISOString(),
      limit: 200,
    });
    expect(deleteUnreferencedBundles).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("deleted 207"));
  });

  it("registers nothing to sweep with when no store is supplied", async () => {
    const boss = bossDouble();

    await startJobConsumers({
      databaseUrl: "postgres://database/tulipfarm",
      database: { query: vi.fn(async () => ({ rows: [] })) } as unknown as Queryable,
      boss: boss as unknown as PgBoss,
      businessId: "business-1",
    });

    expect(boss.createQueue).not.toHaveBeenCalledWith(SOUL_BUNDLE_PRUNE_QUEUE);
  });
});
