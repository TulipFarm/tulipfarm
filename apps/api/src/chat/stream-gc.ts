import type { PgBoss } from "pg-boss";
import type { StreamResumeRepo } from "./stream-resume";

export const STREAM_GC_QUEUE = "stream-resume-gc";
/** Every 10 minutes — sweep cadence for the SSE replay buffer. */
export const STREAM_GC_CRON = "*/10 * * * *";
/** Replay rows live for one hour after they are written, then are GC-eligible. */
export const STREAM_RESUME_TTL_MS = 60 * 60 * 1000;

/**
 * Register the periodic `stream_resume` GC on pg-boss. Each run deletes every event
 * row older than the TTL — covering both finished turns and abandoned ones with one
 * time-based rule. Mirrors `registerSoulSync`.
 */
export async function registerStreamGc(boss: PgBoss, repo: StreamResumeRepo): Promise<void> {
  await boss.createQueue(STREAM_GC_QUEUE);
  await boss.work(STREAM_GC_QUEUE, async () => {
    await repo.deleteOlderThan(new Date(Date.now() - STREAM_RESUME_TTL_MS));
  });
  await boss.schedule(STREAM_GC_QUEUE, STREAM_GC_CRON);
}
