import type PgBoss from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import {
  STREAM_GC_CRON,
  STREAM_GC_QUEUE,
  STREAM_RESUME_TTL_MS,
  registerStreamGc,
} from "./stream-gc";
import { MemoryStreamResumeRepo } from "./stream-resume";

function makeFakeBoss() {
  let workHandler: (() => Promise<void>) | undefined;
  const createQueue = vi.fn(async () => {});
  const schedule = vi.fn(async () => {});
  const work = vi.fn(async (_name: string, handler: () => Promise<void>) => {
    workHandler = handler;
    return "stream-gc-job";
  });
  const boss = { createQueue, schedule, work } as unknown as PgBoss;
  return { boss, createQueue, schedule, work, getWorkHandler: () => workHandler };
}

describe("registerStreamGc", () => {
  it("creates the queue, worker, and 10-minute schedule", async () => {
    const { boss, createQueue, schedule, work } = makeFakeBoss();
    await registerStreamGc(boss, new MemoryStreamResumeRepo());
    expect(createQueue).toHaveBeenCalledWith(STREAM_GC_QUEUE);
    expect(work).toHaveBeenCalledWith(STREAM_GC_QUEUE, expect.any(Function));
    expect(schedule).toHaveBeenCalledWith(STREAM_GC_QUEUE, STREAM_GC_CRON);
  });

  it("worker deletes rows older than the TTL and keeps fresh ones", async () => {
    const repo = new MemoryStreamResumeRepo();
    const sid = "00000000-0000-0000-0000-000000000001";
    await repo.append({
      streamId: sid,
      seq: 1,
      eventType: "text",
      data: {},
      createdAt: new Date(Date.now() - STREAM_RESUME_TTL_MS - 60_000),
    });
    await repo.append({
      streamId: sid,
      seq: 2,
      eventType: "text",
      data: {},
      createdAt: new Date(),
    });

    const { boss, getWorkHandler } = makeFakeBoss();
    await registerStreamGc(boss, repo);
    await getWorkHandler()?.();

    const remaining = await repo.listAfter(sid, 0);
    expect(remaining.map((e) => e.seq)).toEqual([2]);
  });
});
