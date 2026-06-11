import type { PgBoss } from "pg-boss";

interface SoulSyncer {
  syncOnce(): Promise<void>;
}

export const SOUL_SYNC_QUEUE = "soul-sync";
/** Every 5 minutes — the periodic soul down-sync cadence. */
export const SOUL_SYNC_CRON = "*/5 * * * *";

/**
 * Registers the periodic soul git-sync on pg-boss. Gated on a configured git remote —
 * without one there is nothing to sync. Returns whether the schedule was registered.
 */
export async function registerSoulSync(
  boss: PgBoss,
  syncer: SoulSyncer,
  gitRemoteUrl: string | undefined
): Promise<boolean> {
  if (!gitRemoteUrl) {
    return false;
  }
  await boss.createQueue(SOUL_SYNC_QUEUE);
  await boss.work(SOUL_SYNC_QUEUE, () => syncer.syncOnce());
  await boss.schedule(SOUL_SYNC_QUEUE, SOUL_SYNC_CRON);
  return true;
}
