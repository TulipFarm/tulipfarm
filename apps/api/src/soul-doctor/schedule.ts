import type { PgBoss } from "pg-boss";

export const SOUL_DOCTOR_QUEUE = "soul-doctor";

/**
 * Five minutes, matching `SOUL_SYNC_INTERVAL_MS`.
 *
 * The sweep is also kicked from the sync's `reconcile` hook, so a bad push is seen as soon as it
 * lands; the cron exists for the other half — Run health, which goes wrong while the soul repo is
 * perfectly quiet.
 */
export const SOUL_DOCTOR_CRON = "*/5 * * * *";

/**
 * Registers the sweep tick and its consumer.
 *
 * The consumer runs here rather than in the Worker because everything it touches is the API's:
 * the authored Soul worktree, the `SoulWriter` gateway that is the only door to it, and the
 * publication that follows a repair. `registerScheduleDispatch` already establishes the shape for
 * a schedule the API both publishes and consumes.
 */
export async function registerSoulDoctorSchedule(
  boss: PgBoss,
  doctor: { sweep(): Promise<unknown> },
  opts: { log?: { error(obj: unknown, msg?: string): void } } = {}
): Promise<void> {
  await boss.createQueue(SOUL_DOCTOR_QUEUE, { policy: "exclusive" });
  await boss.work(SOUL_DOCTOR_QUEUE, async () => {
    try {
      await doctor.sweep();
    } catch (error) {
      // Swallowed rather than rethrown: pg-boss would retry, and the next tick is five minutes
      // away — a retry would re-diagnose a Soul nothing has changed since.
      opts.log?.error({ error }, "soul doctor sweep failed");
    }
  });
  await boss.schedule(SOUL_DOCTOR_QUEUE, SOUL_DOCTOR_CRON);
}

/**
 * Runs the sweep out of band, swallowing its failure.
 *
 * Called from the soul-sync `reconcile` hook, whose own work is already committed: a failed sweep
 * must cost no more than a wait for the next cron tick.
 */
export async function kickSoulDoctor(
  doctor: { sweep(): Promise<unknown> } | undefined,
  log: { error(obj: unknown, msg?: string): void } | undefined,
  because: string
): Promise<void> {
  if (!doctor) return;
  try {
    await doctor.sweep();
  } catch (error) {
    log?.error({ error }, `soul doctor sweep after ${because} failed`);
  }
}
