import type { PgBoss } from "pg-boss";
import type { RoutineRegistry } from "./registry";
import type { RoutineTriggerService } from "./trigger-service";

export const ROUTINE_CRON_QUEUE = "routine-cron";

type SchedulesLogger = {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

interface CronJobData {
  slug: string;
  triggerIndex: number;
}

/**
 * One static `routine-cron` queue + keyed schedules (review fix B4): every cron trigger
 * of every valid routine is a pg-boss schedule on the same queue with
 * key `{slug}.{index}`. The single worker (registered once at boot) turns a firing into
 * `trigger(slug, { type: "cron" })`. No dynamic per-slug queues — they would have no
 * workers after reload.
 */
export async function registerRoutineCronWorker(
  boss: PgBoss,
  service: RoutineTriggerService,
  log: SchedulesLogger
): Promise<void> {
  await boss.createQueue(ROUTINE_CRON_QUEUE);
  await boss.work(ROUTINE_CRON_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as unknown as CronJobData;
      try {
        await service.trigger(data.slug, { type: "cron", triggerIndex: data.triggerIndex });
      } catch (err) {
        // Routine deleted/invalid between unschedule and firing — log, don't retry.
        log.warn({ err, slug: data.slug }, "cron-triggered routine failed to start");
      }
    }
  });
}

/**
 * Diffs desired cron schedules (from the registry's valid routines) against pg-boss's
 * keyed schedules on `routine-cron`: schedules new/changed ones (tz from
 * `x-trigger.timezone`, default UTC) and unschedules keys whose routine or trigger
 * disappeared (handles routine deletion). Runs at boot and on every `soul.synced`.
 */
export async function reconcileRoutineSchedules(
  boss: PgBoss,
  registry: RoutineRegistry,
  log: SchedulesLogger
): Promise<void> {
  const desired = new Map<string, { cron: string; tz: string; data: CronJobData }>();
  for (const routine of registry.valid()) {
    routine.definition["x-triggers"].forEach((trigger, i) => {
      if (trigger.type !== "cron") return;
      desired.set(`${routine.slug}.${i}`, {
        cron: trigger.schedule,
        tz: trigger.timezone ?? "UTC",
        data: { slug: routine.slug, triggerIndex: i },
      });
    });
  }

  const existing = await boss.getSchedules(ROUTINE_CRON_QUEUE);
  const existingByKey = new Map(existing.map((s) => [s.key, s]));

  for (const [key, want] of desired) {
    const have = existingByKey.get(key);
    if (have && have.cron === want.cron && (have.timezone ?? "UTC") === want.tz) continue;
    try {
      await boss.schedule(ROUTINE_CRON_QUEUE, want.cron, want.data as unknown as object, {
        key,
        tz: want.tz,
      });
    } catch (err) {
      log.error({ err, key, cron: want.cron }, "failed to schedule routine cron");
    }
  }

  for (const s of existing) {
    if (!desired.has(s.key)) {
      try {
        await boss.unschedule(ROUTINE_CRON_QUEUE, s.key);
      } catch (err) {
        log.error({ err, key: s.key }, "failed to unschedule routine cron");
      }
    }
  }
}
