import type { PgBoss } from "pg-boss";
import { recordJobRun } from "../activity/job-run";
import type { ActivityService } from "../activity/service";
import { recordObsJobRun } from "./job-run";
import type { ObsRepo } from "./repo";
import type { ObservabilityService } from "./service";

export const OBS_PRUNE_QUEUE = "obs-event-prune";
/** Daily at 03:17 — off-peak sweep cadence for the observability event spine. */
export const OBS_PRUNE_CRON = "17 3 * * *";
/** Default retention: raw events live 90 days (overridable via observability config). */
export const OBS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface ObsPruneOpts {
  /** Retention window in ms (default 90d). Sourced from observability config when present. */
  retentionMs?: number;
  /** Records the prune run as a `job` obs_event, in addition to the activity feed. */
  obs?: ObservabilityService;
}

/**
 * Register the periodic `obs_event` prune on pg-boss. Each run deletes every event older than the
 * retention window. Mirrors `registerStreamGc`; the run is recorded to the activity feed
 * (`recordJobRun`) and, when an obs service is given, as a `job` obs_event (`recordObsJobRun`).
 */
export async function registerObsPrune(
  boss: PgBoss,
  repo: ObsRepo,
  activity?: ActivityService,
  opts: ObsPruneOpts = {}
): Promise<void> {
  const retentionMs = opts.retentionMs ?? OBS_RETENTION_MS;
  await boss.createQueue(OBS_PRUNE_QUEUE);
  await boss.work(OBS_PRUNE_QUEUE, () =>
    recordJobRun(activity, OBS_PRUNE_QUEUE, () =>
      recordObsJobRun(opts.obs, OBS_PRUNE_QUEUE, async () => {
        await repo.deleteOlderThan(new Date(Date.now() - retentionMs));
      })
    )
  );
  await boss.schedule(OBS_PRUNE_QUEUE, OBS_PRUNE_CRON);
}
