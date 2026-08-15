import {
  OBS_RETENTION_MS,
  PgLogPruner,
  PgObservabilityPruner,
  PgResourceSamplePruner,
  RESOURCE_RETENTION_MS,
} from "@tulipfarm/observability";
import { type ConstructorOptions, PgBoss } from "pg-boss";
import type { Queryable } from "./db";
import { breached, readSpendWindow, spendAlertMessage } from "./spend-alert";

export const OBS_PRUNE_QUEUE = "obs-event-prune";
export const SPEND_ALERT_QUEUE = "obs-spend-alert";

export interface JobConsumerOptions {
  readonly databaseUrl: string;
  readonly database: Queryable;
  readonly now?: () => Date;
  /** Test seam; production always constructs the non-migrating client below. */
  readonly boss?: PgBoss;
  /** Where a breached spend ceiling is reported; the operator log spine in production. */
  readonly log?: { error(message: string): void };
}

interface ObservabilityPruneJob {
  readonly retentionMs?: number;
}

interface SpendAlertJob {
  readonly thresholdUsd?: number;
}

/**
 * Attach to the pg-boss schema the API already migrated, then register every Worker-owned
 * consumer. `migrate: false` is load-bearing: this process never creates or changes a schema.
 */
export async function startJobConsumers(options: JobConsumerOptions): Promise<PgBoss> {
  const boss = options.boss ?? new PgBoss(jobBossOptions(options.databaseUrl));
  await boss.start();

  const now = options.now ?? (() => new Date());
  const pruner = new PgObservabilityPruner(options.database);
  const logPruner = new PgLogPruner(options.database);
  const resourcePruner = new PgResourceSamplePruner(options.database);
  await boss.createQueue(OBS_PRUNE_QUEUE);
  await boss.work<ObservabilityPruneJob>(OBS_PRUNE_QUEUE, async (jobs) => {
    const configured = jobs[0]?.data.retentionMs;
    const retentionMs =
      typeof configured === "number" && configured > 0 ? configured : OBS_RETENTION_MS;
    const cutoff = new Date(now().getTime() - retentionMs);
    await pruner.deleteOlderThan(cutoff);
    // Same window, same sweep: both spines are raw telemetry under one retention policy. Failing
    // the job on a missing log_event would also strand obs_event, so the delete runs after it.
    await logPruner.deleteOlderThan(cutoff);
    // Samples get their own, shorter window. They arrive on a clock rather than on events, so the
    // 90-day policy above would keep two orders of magnitude more rows than the 24h chart can show.
    // The job override deliberately does not apply — it configures the event window, not this one.
    await resourcePruner.deleteOlderThan(new Date(now().getTime() - RESOURCE_RETENTION_MS));
  });

  await boss.createQueue(SPEND_ALERT_QUEUE);
  await boss.work<SpendAlertJob>(SPEND_ALERT_QUEUE, async (jobs) => {
    const thresholdUsd = jobs[0]?.data.thresholdUsd;
    // No threshold means the operator set none. There is no default budget to fall back to.
    if (typeof thresholdUsd !== "number" || thresholdUsd <= 0) return;
    const window = await readSpendWindow(options.database, thresholdUsd, now());
    if (!breached(window)) return;
    options.log?.error(spendAlertMessage(window));
  });

  return boss;
}

export function jobBossOptions(databaseUrl: string): ConstructorOptions {
  return { connectionString: databaseUrl, migrate: false };
}
