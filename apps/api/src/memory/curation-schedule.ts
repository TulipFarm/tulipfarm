import type { PgBoss } from "pg-boss";

// Must match `MEMORY_CURATION_QUEUE` in `apps/worker/src/job-consumers.ts`.
export const MEMORY_CURATION_QUEUE = "memory-curation";

/**
 * On the hour, every hour.
 *
 * The Curator reads what a person said since it last ran, so the interval *is* the window. An hour
 * is long enough that a conversation has finished before it is read — curating mid-sentence
 * records half a thought — and short enough that a preference stated this morning is honoured this
 * afternoon. A tick with no new Turns makes no model call, so the idle hours are free.
 */
export const MEMORY_CURATION_CRON = "0 * * * *";

export async function registerMemoryCurationSchedule(boss: PgBoss): Promise<void> {
  await boss.createQueue(MEMORY_CURATION_QUEUE);
  await boss.schedule(MEMORY_CURATION_QUEUE, MEMORY_CURATION_CRON);
}
