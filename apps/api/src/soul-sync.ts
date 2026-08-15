import { recordJobRun } from "@tulipfarm/observability";
import type { ActivityService } from "./activity/service";

interface SoulSyncer {
  syncOnce(): Promise<void>;
}

/** Structural SoulLoader subset for diffing named artifacts after reload. */
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
  log?: { error(obj: unknown, msg?: string): void };
  /**
   * After git pull, reconcile active bundles because remote commits bypass the local commit hook.
   */
  reconcile?: () => Promise<void>;
}

export const SOUL_SYNC_JOB = "soul-sync";
export const SOUL_SYNC_INTERVAL_MS = 5 * 60 * 1000;

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

/** Register remote-gated periodic Soul sync and return its interval for shutdown. */
export function registerSoulSync(
  syncer: SoulSyncer,
  gitRemoteUrl: string | undefined,
  opts: SoulSyncOptions = {}
): ReturnType<typeof setInterval> | undefined {
  if (!gitRemoteUrl) return undefined;

  const { activity, soulLoader, log, reconcile } = opts;
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void recordJobRun(activity, SOUL_SYNC_JOB, async () => {
      const before = activity && soulLoader ? snapshot(soulLoader) : null;
      await syncer.syncOnce();
      if (activity && soulLoader && before) {
        await soulLoader.reload();
        await recordSoulDiff(activity, before, snapshot(soulLoader));
      }
      if (reconcile) await reconcile();
    })
      .catch((error: unknown) => {
        log?.error({ error }, "periodic soul sync failed");
      })
      .finally(() => {
        running = false;
      });
  }, SOUL_SYNC_INTERVAL_MS);
}
