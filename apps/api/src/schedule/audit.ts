import type { PgBoss } from "pg-boss";

/**
 * pg-boss schedules live in Postgres, independent of which code is deployed: a queue whose
 * `register*Schedule` call is removed keeps enqueuing forever unless something explicitly
 * unschedules it (issue #750 — `slack-knowledge-sync` kept firing for a day after its consumer
 * was retired, because nothing did). Call this once, after every schedule this boot intends to
 * keep has been (re)registered, with the full list of those queue names: anything pg-boss still
 * has scheduled outside that list is an orphan from a previous deploy, logged loudly so it does
 * not silently pile up `created` jobs the way this one did.
 */
export async function auditPersistedSchedules(
  boss: PgBoss,
  activeQueueNames: readonly string[],
  log: { error(obj: unknown, msg?: string): void }
): Promise<void> {
  const active = new Set(activeQueueNames);
  let schedules: Awaited<ReturnType<PgBoss["getSchedules"]>>;
  try {
    schedules = await boss.getSchedules();
  } catch (err) {
    // A diagnostic must never block boot — surface it and move on.
    log.error({ err }, "pg-boss schedule audit failed");
    return;
  }
  for (const schedule of schedules) {
    if (!active.has(schedule.name)) {
      log.error(
        { queue: schedule.name },
        `pg-boss schedule "${schedule.name}" has no registered consumer this boot — jobs will ` +
          `pile up in "created" forever. Call boss.unschedule("${schedule.name}") on boot to retire it.`
      );
    }
  }
}
