import { SOUL_BUNDLE_RETENTION_DAYS } from "@tulipfarm/soul";
import type { PgBoss } from "pg-boss";

// Must match `SOUL_BUNDLE_PRUNE_QUEUE` in `apps/worker/src/job-consumers.ts` — pg-boss queue names
// cross the process boundary as plain strings, the same split `OBS_PRUNE_QUEUE` already uses.
export const SOUL_BUNDLE_PRUNE_QUEUE = "soul-bundle-prune";

/** Daily at 04:43 — off-peak, and clear of the 03:17 observability sweep. */
export const SOUL_BUNDLE_PRUNE_CRON = "43 4 * * *";

/** Below this the cutoff could reach bundles whose Runs or activations are still being written. */
const MINIMUM_RETENTION_DAYS = 7;

/**
 * Retention window for published execution bundles, in ms.
 *
 * Unlike observability retention this is not Soul Config: it protects the Soul's own published
 * artifacts, so an Agent editing Soul Config must not be able to shorten it. It is an operator
 * env knob with a floor, in the shape `@tulipfarm/constants` already uses for env-backed values.
 */
export function bundleRetentionMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.SOUL_BUNDLE_RETENTION_DAYS);
  const days = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : SOUL_BUNDLE_RETENTION_DAYS;
  return Math.max(MINIMUM_RETENTION_DAYS, days) * 24 * 60 * 60 * 1000;
}

/**
 * Publishes the retention policy with each scheduled sweep. The API owns schedule registration;
 * the Worker owns the consumer, the bounded batching and the delete.
 */
export async function registerSoulBundlePruneSchedule(
  boss: PgBoss,
  retentionMs: number
): Promise<void> {
  await boss.createQueue(SOUL_BUNDLE_PRUNE_QUEUE);
  await boss.schedule(SOUL_BUNDLE_PRUNE_QUEUE, SOUL_BUNDLE_PRUNE_CRON, { retentionMs });
}
