import { z } from 'zod';

type Pool = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };

export const githubDeliveryRetentionDefaultHours = 6;
const retentionSchema = z.number().int().min(1).max(720);
const batchSize = 500;

/**
 * Reads `GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS`: how long a processed GitHub webhook delivery is kept to recognize
 * redeliveries of the same delivery ID. 1 to 720 hours; unset or empty uses the default.
 */
export function githubDeliveryRetentionHours(value: string | undefined) {
  const text = value?.trim();
  if (!text) return githubDeliveryRetentionDefaultHours;
  const hours = /^[0-9]+$/.test(text) ? retentionSchema.safeParse(Number(text)) : undefined;
  if (!hours?.success) throw new Error('GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS must be a whole number from 1 to 720');
  return hours.data;
}

/**
 * Deletes processed GitHub webhook deliveries received more than `retentionHours` ago, in short batches so no
 * statement holds row locks for long. Pending deliveries and deliveries still referenced by a payload or dispatch are
 * kept. Returns how many were deleted; stops after `maxBatches` so one run stays bounded.
 */
export async function pruneGitHubEventDeliveries(pool: Pool, options: { retentionHours: number; maxBatches?: number }) {
  const hours = retentionSchema.parse(options.retentionHours);
  const batches = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.maxBatches ?? 20);
  let deleted = 0;
  for (let batch = 0; batch < batches; batch++) {
    const { removed } = z
      .object({ removed: z.number().int().min(0) })
      .parse(
        (
          await pool.query('SELECT app.prune_github_event_deliveries($1::integer, $2::integer) AS removed', [
            hours,
            batchSize,
          ])
        ).rows[0],
      );
    deleted += removed;
    if (removed < batchSize) break;
  }
  return deleted;
}

/** Deletes webhook delivery bodies older than one minute, in short batches. Returns how many were deleted. */
export async function pruneGitHubEventBodies(pool: Pool, options: { maxBatches?: number } = {}) {
  const batches = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.maxBatches ?? 20);
  let deleted = 0;
  for (let batch = 0; batch < batches; batch++) {
    const { removed } = z
      .object({ removed: z.number().int().min(0) })
      .parse((await pool.query('SELECT app.prune_github_event_bodies($1::integer) AS removed', [batchSize])).rows[0]);
    deleted += removed;
    if (removed < batchSize) break;
  }
  return deleted;
}
