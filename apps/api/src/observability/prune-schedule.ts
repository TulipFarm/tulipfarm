import type { PgBoss } from "pg-boss";

export const OBS_PRUNE_QUEUE = "obs-event-prune";
/** Daily at 03:17 — off-peak sweep cadence for the observability event spine. */
export const OBS_PRUNE_CRON = "17 3 * * *";

/**
 * Publishes the retention policy with each scheduled prune. The API owns Soul Config and durable
 * submission; the Worker owns the consumer and the delete.
 */
export async function registerObsPruneSchedule(boss: PgBoss, retentionMs: number): Promise<void> {
  await boss.createQueue(OBS_PRUNE_QUEUE);
  await boss.schedule(OBS_PRUNE_QUEUE, OBS_PRUNE_CRON, { retentionMs });
}
