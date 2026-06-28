import type { PgBoss } from "pg-boss";
import { recordJobRun } from "./activity/job-run";
import type { ActivityService } from "./activity/service";

interface SoulSyncer {
  syncOnce(): Promise<void>;
}

/**
 * The subset of `SoulLoader` this module diffs: the four named-artifact maps + a `reload()` to
 * refresh them from disk after a pull. Kept structural so tests can pass a plain fake.
 */
export interface SoulArtifacts {
  agents: Map<string, unknown>;
  routines: Map<string, unknown>;
  integrations: Map<string, unknown>;
  skills: Map<string, unknown>;
  reload(): Promise<void>;
}

export interface SoulSyncOptions {
  activity?: ActivityService;
  soulLoader?: SoulArtifacts;
}

export const SOUL_SYNC_QUEUE = "soul-sync";
/** Every 5 minutes — the periodic soul down-sync cadence. */
export const SOUL_SYNC_CRON = "*/5 * * * *";

// Singular activity "kind" → the plural SoulArtifacts map key.
const SOUL_KINDS = [
  ["agent", "agents"],
  ["routine", "routines"],
  ["integration", "integrations"],
  ["skill", "skills"],
] as const;

type SoulSnapshot = Record<(typeof SOUL_KINDS)[number][1], Set<string>>;

function snapshot(soul: SoulArtifacts): SoulSnapshot {
  return {
    agents: new Set(soul.agents.keys()),
    routines: new Set(soul.routines.keys()),
    integrations: new Set(soul.integrations.keys()),
    skills: new Set(soul.skills.keys()),
  };
}

/** Record one `soul.<kind>.created` row for every artifact present after the sync but not before. */
async function recordSoulDiff(
  activity: ActivityService,
  before: SoulSnapshot,
  after: SoulSnapshot
): Promise<void> {
  for (const [kind, key] of SOUL_KINDS) {
    for (const name of after[key]) {
      if (!before[key].has(name)) {
        await activity.record({
          category: "soul",
          action: `soul.${kind}.created`,
          targetType: kind,
          targetId: name,
          summary: `New ${kind} "${name}" added via soul sync`,
        });
      }
    }
  }
}

/**
 * Registers the periodic soul git-sync on pg-boss. Gated on a configured git remote —
 * without one there is nothing to sync. Returns whether the schedule was registered.
 *
 * When an activity service + soul loader are supplied, each run is recorded (category 'job') and
 * newly-added agents/routines/integrations/skills are detected by diffing the loader's artifact
 * key sets before vs after the pull (an explicit `reload()` makes the "after" snapshot deterministic;
 * the redundant reload is harmless — `load()` replaces whole maps).
 */
export async function registerSoulSync(
  boss: PgBoss,
  syncer: SoulSyncer,
  gitRemoteUrl: string | undefined,
  opts: SoulSyncOptions = {}
): Promise<boolean> {
  if (!gitRemoteUrl) {
    return false;
  }
  const { activity, soulLoader } = opts;
  await boss.createQueue(SOUL_SYNC_QUEUE);
  await boss.work(SOUL_SYNC_QUEUE, () =>
    recordJobRun(activity, SOUL_SYNC_QUEUE, async () => {
      const before = activity && soulLoader ? snapshot(soulLoader) : null;
      await syncer.syncOnce();
      if (activity && soulLoader && before) {
        await soulLoader.reload();
        await recordSoulDiff(activity, before, snapshot(soulLoader));
      }
    })
  );
  await boss.schedule(SOUL_SYNC_QUEUE, SOUL_SYNC_CRON);
  return true;
}
