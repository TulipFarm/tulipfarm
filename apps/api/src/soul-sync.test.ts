import type PgBoss from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { SOUL_SYNC_CRON, SOUL_SYNC_QUEUE, registerSoulSync } from "./soul-sync";

function makeFakeBoss() {
  let workHandler: (() => Promise<void>) | undefined;
  const createQueue = vi.fn(async () => {});
  const schedule = vi.fn(async () => {});
  const work = vi.fn(async (_name: string, handler: () => Promise<void>) => {
    workHandler = handler;
    return "soul-sync-job";
  });
  const boss = { createQueue, schedule, work } as unknown as PgBoss;
  return { boss, createQueue, schedule, work, getWorkHandler: () => workHandler };
}

const REMOTE = "https://github.com/example/soul.git";

describe("registerSoulSync", () => {
  it("creates the queue, worker, and 5-minute schedule when a remote is configured", async () => {
    const { boss, createQueue, schedule, work } = makeFakeBoss();
    const syncer = { syncOnce: vi.fn(async () => {}) };

    const registered = await registerSoulSync(boss, syncer, REMOTE);

    expect(registered).toBe(true);
    expect(createQueue).toHaveBeenCalledWith(SOUL_SYNC_QUEUE);
    expect(work).toHaveBeenCalledWith(SOUL_SYNC_QUEUE, expect.any(Function));
    expect(schedule).toHaveBeenCalledWith(SOUL_SYNC_QUEUE, SOUL_SYNC_CRON);
    expect(SOUL_SYNC_CRON).toBe("*/5 * * * *");
  });

  it("registers a worker that delegates to syncer.syncOnce", async () => {
    const { boss, getWorkHandler } = makeFakeBoss();
    const syncer = { syncOnce: vi.fn(async () => {}) };

    await registerSoulSync(boss, syncer, REMOTE);
    await getWorkHandler()?.();

    expect(syncer.syncOnce).toHaveBeenCalledOnce();
  });

  it("registers nothing when no git remote is configured", async () => {
    const { boss, createQueue, schedule, work } = makeFakeBoss();
    const syncer = { syncOnce: vi.fn(async () => {}) };

    const registered = await registerSoulSync(boss, syncer, undefined);

    expect(registered).toBe(false);
    expect(createQueue).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
});
