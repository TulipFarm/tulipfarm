import {
  OBS_RETENTION_MS,
  PgLogPruner,
  PgObservabilityPruner,
  PgResourceSamplePruner,
  RESOURCE_RETENTION_MS,
} from "@tulipfarm/observability";
import {
  bundleRetentionMessage,
  pruneUnreferencedBundles,
  SOUL_BUNDLE_RETENTION_MS,
  type UnreferencedBundleDeleter,
} from "@tulipfarm/soul";
import type { TaskStore } from "@tulipfarm/storage";
import { type ConstructorOptions, PgBoss } from "pg-boss";
import type { Queryable } from "./db";
import {
  FILE_INDEX_QUEUE,
  type FileIndexDeps,
  type FileIndexJob,
  handleFileIndexJob,
} from "./knowledge/file-index";
import { reconcileTasks } from "./reconcile/task-reconciler";
import type { TaskSignalsGatherer } from "./reconcile/task-signals";
import { breached, readSpendWindow, spendAlertMessage } from "./spend-alert";

export const OBS_PRUNE_QUEUE = "obs-event-prune";
export const SPEND_ALERT_QUEUE = "obs-spend-alert";

/** Must match `SOUL_BUNDLE_PRUNE_QUEUE` in `apps/api/src/soul/bundle-prune-schedule.ts`. */
export const SOUL_BUNDLE_PRUNE_QUEUE = "soul-bundle-prune";

/** The five-minute maintenance sweep every open Task and Curator Run derives from. */
export const CURATOR_SWEEP_QUEUE = "curator-sweep";

/**
 * Debounce window for the boot reconcile below. `tsx watch` restarts the Worker on every save, so
 * without a window a dev session enqueues one reconcile per keystroke-triggered restart.
 */
const BOOT_RECONCILE_DEBOUNCE_SECONDS = 60;

export interface JobConsumerOptions {
  readonly databaseUrl: string;
  readonly database: Queryable;
  readonly now?: () => Date;
  /** Test seam; production always constructs the non-migrating client below. */
  readonly boss?: PgBoss;
  /** Where a breached spend ceiling is reported; the operator log spine in production. */
  readonly log?: { error(message: string): void; info?(message: string): void };
  /**
   * Task reconciler deps. Optional so pruning-only test setups need not wire them; production
   * always supplies all three together (see `main.ts`), so the reconcile queue is simply not
   * registered without them.
   */
  readonly businessId?: string;
  readonly taskStore?: TaskStore;
  readonly taskSignals?: TaskSignalsGatherer;
  /**
   * Curator fan-out, composed by `main.ts`. Absent leaves the sweep deterministic-only, which is
   * exactly what an instance with the loop disabled should do — the setup Tasks still surface.
   */
  readonly curatorSweep?: () => Promise<unknown>;
  /**
   * Published-bundle retention. Paired with `businessId` for the same reason as the reconciler:
   * without both there is nothing to sweep, so the queue is simply not registered.
   */
  readonly bundles?: UnreferencedBundleDeleter;
  /**
   * File-into-Knowledge indexing. Absent leaves the queue unregistered, which is the honest state
   * for a composition with no blob store: jobs then wait rather than being consumed and dropped.
   */
  readonly fileIndex?: FileIndexDeps;
}

interface ObservabilityPruneJob {
  readonly retentionMs?: number;
}

interface SpendAlertJob {
  readonly thresholdUsd?: number;
}

interface SoulBundlePruneJob {
  readonly retentionMs?: number;
}

/**
 * Reports what nothing else in a handler would: that a queue is live, and — if the handler
 * throws — that it did. pg-boss records a failed job in its own tables, but nothing carried that
 * fact to the operator log spine, so a queue that stopped draining looked identical to one that
 * was never subscribed at all.
 */
function logSubscribed(log: JobConsumerOptions["log"], queue: string): void {
  log?.info?.(`queue subscribed queue=${queue}`);
}

function logHandlerThrew(log: JobConsumerOptions["log"], queue: string, error: unknown): void {
  log?.error(
    `queue handler threw queue=${queue} — ${error instanceof Error ? error.message : String(error)}`
  );
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
    try {
      const configured = jobs[0]?.data.retentionMs;
      const retentionMs =
        typeof configured === "number" && configured > 0 ? configured : OBS_RETENTION_MS;
      const cutoff = new Date(now().getTime() - retentionMs);
      const deletedObsEvents = await pruner.deleteOlderThan(cutoff);
      // Same window, same sweep: both spines are raw telemetry under one retention policy. Failing
      // the job on a missing log_event would also strand obs_event, so the delete runs after it.
      const deletedLogEvents = await logPruner.deleteOlderThan(cutoff);
      // Samples get their own, shorter window. They arrive on a clock rather than on events, so the
      // 90-day policy above would keep two orders of magnitude more rows than the 24h chart can
      // show. The job override deliberately does not apply — it configures the event window, not
      // this one.
      const deletedSamples = await resourcePruner.deleteOlderThan(
        new Date(now().getTime() - RESOURCE_RETENTION_MS)
      );
      // Reported every pass, zero-delete included, the same convention as bundle retention below —
      // an operator otherwise cannot tell a queue that swept nothing from one that never ran.
      options.log?.info?.(
        `obs-prune deleted obs_event=${deletedObsEvents} log_event=${deletedLogEvents} resource_sample=${deletedSamples}`
      );
    } catch (error) {
      logHandlerThrew(options.log, OBS_PRUNE_QUEUE, error);
      throw error;
    }
  });
  logSubscribed(options.log, OBS_PRUNE_QUEUE);

  await boss.createQueue(SPEND_ALERT_QUEUE);
  await boss.work<SpendAlertJob>(SPEND_ALERT_QUEUE, async (jobs) => {
    try {
      const thresholdUsd = jobs[0]?.data.thresholdUsd;
      // No threshold means the operator set none. There is no default budget to fall back to.
      if (typeof thresholdUsd !== "number" || thresholdUsd <= 0) return;
      const window = await readSpendWindow(options.database, thresholdUsd, now());
      if (!breached(window)) return;
      options.log?.error(spendAlertMessage(window));
    } catch (error) {
      logHandlerThrew(options.log, SPEND_ALERT_QUEUE, error);
      throw error;
    }
  });
  logSubscribed(options.log, SPEND_ALERT_QUEUE);

  if (options.businessId !== undefined && options.bundles) {
    const businessId = options.businessId;
    const bundles = options.bundles;
    await boss.createQueue(SOUL_BUNDLE_PRUNE_QUEUE);
    await boss.work<SoulBundlePruneJob>(SOUL_BUNDLE_PRUNE_QUEUE, async (jobs) => {
      try {
        const configured = jobs[0]?.data.retentionMs;
        const retentionMs =
          typeof configured === "number" && configured > 0 ? configured : SOUL_BUNDLE_RETENTION_MS;
        const result = await pruneUnreferencedBundles({
          store: bundles,
          businessId,
          now: now(),
          retentionMs,
        });
        // The pass is bounded, so a large backlog drains across scheduled runs. Reporting every
        // pass — including the zero-delete ones — is how an operator sees that it is keeping up.
        options.log?.info?.(bundleRetentionMessage(businessId, result));
      } catch (error) {
        logHandlerThrew(options.log, SOUL_BUNDLE_PRUNE_QUEUE, error);
        throw error;
      }
    });
    logSubscribed(options.log, SOUL_BUNDLE_PRUNE_QUEUE);
  }

  if (options.businessId !== undefined && options.taskStore && options.taskSignals) {
    const businessId = options.businessId;
    const taskStore = options.taskStore;
    const taskSignals = options.taskSignals;
    const curatorSweep = options.curatorSweep;
    await boss.createQueue(CURATOR_SWEEP_QUEUE);
    await boss.work(CURATOR_SWEEP_QUEUE, async () => {
      try {
        // Deterministic first, and never inside the Curator's try: a model outage, an exhausted
        // budget or a missing provider must still leave "Connect a model provider" on screen. That
        // Task is how the operator fixes the very thing the Curator half needs.
        const signals = await taskSignals.gather(businessId);
        await reconcileTasks({ businessId, signals, taskStore, now: now() });
        if (curatorSweep) await curatorSweep();
      } catch (error) {
        logHandlerThrew(options.log, CURATOR_SWEEP_QUEUE, error);
        throw error;
      }
    });
    logSubscribed(options.log, CURATOR_SWEEP_QUEUE);
    // Minute 0, not minute 5. The cron alone leaves a fresh instance with an empty Tasks list
    // until the next tick, hiding the very setup gaps a first boot needs to surface. The
    // dedicated singletonKey keeps this out of the scheduler's own dedupe slot, so a boot kick can
    // never swallow a cron tick.
    await boss.send(
      CURATOR_SWEEP_QUEUE,
      {},
      { singletonKey: "boot", singletonSeconds: BOOT_RECONCILE_DEBOUNCE_SECONDS }
    );
  }

  if (options.fileIndex) {
    const fileIndex = options.fileIndex;
    await boss.createQueue(FILE_INDEX_QUEUE);
    await boss.work<FileIndexJob>(FILE_INDEX_QUEUE, async (jobs) => {
      try {
        for (const job of jobs) {
          const outcome = await handleFileIndexJob(job.data, fileIndex);
          // A skip is reported rather than thrown. Every reason for one is a fact about the File a
          // retry cannot change, so failing the job would only re-read the same bytes three times
          // before giving up, and say nothing about why to whoever asked for the indexing.
          if (outcome.kind === "skipped") {
            options.log?.info?.(`file ${job.data.fileId} not indexed: ${outcome.reason}`);
          }
        }
      } catch (error) {
        logHandlerThrew(options.log, FILE_INDEX_QUEUE, error);
        throw error;
      }
    });
    logSubscribed(options.log, FILE_INDEX_QUEUE);
  }

  return boss;
}

export function jobBossOptions(databaseUrl: string): ConstructorOptions {
  return { connectionString: databaseUrl, migrate: false };
}
