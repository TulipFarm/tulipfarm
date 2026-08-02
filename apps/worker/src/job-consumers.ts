import { OBS_RETENTION_MS, PgObservabilityPruner } from "@tulipfarm/observability";
import { type ConstructorOptions, PgBoss } from "pg-boss";
import type { Queryable } from "./db";

export const OBS_PRUNE_QUEUE = "obs-event-prune";

export interface JobConsumerOptions {
  readonly databaseUrl: string;
  readonly database: Queryable;
  readonly now?: () => Date;
  /** Test seam; production always constructs the non-migrating client below. */
  readonly boss?: PgBoss;
}

interface ObservabilityPruneJob {
  readonly retentionMs?: number;
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
  await boss.createQueue(OBS_PRUNE_QUEUE);
  await boss.work<ObservabilityPruneJob>(OBS_PRUNE_QUEUE, async (jobs) => {
    const configured = jobs[0]?.data.retentionMs;
    const retentionMs =
      typeof configured === "number" && configured > 0 ? configured : OBS_RETENTION_MS;
    await pruner.deleteOlderThan(new Date(now().getTime() - retentionMs));
  });

  return boss;
}

export function jobBossOptions(databaseUrl: string): ConstructorOptions {
  return { connectionString: databaseUrl, migrate: false };
}
