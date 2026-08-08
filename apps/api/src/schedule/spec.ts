import type { ScheduleSpec, ScheduleType } from "@tulipfarm/run-kernel";

/** One `x-triggers` entry that is a schedule type, with its position in the array. */
export interface RoutineScheduleTrigger {
  readonly triggerIndex: number;
  readonly spec: ScheduleSpec;
}

const SCHEDULE_TYPES = new Set<ScheduleType>(["cron", "interval", "datetime"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * V1 fixed policy — see `docs/plans/2026-08-08-routine-cron-scheduler-design.md`: no authored
 * catch-up/overlap/jitter/calendar yet, matches `planSchedule`'s own defaults for these fields.
 */
const FIXED_POLICY = {
  dstPolicy: "forward_only",
  missedRunPolicy: "skip",
  overlapPolicy: "skip",
} as const;

/**
 * Read the schedule-type entries out of a Routine's raw `x-triggers` config (the embedded array
 * `routine_forge` authors, validated against `packages/schema/src/routine.ts`'s `Trigger` union at
 * write time — this reads it back unchecked, since a dispatcher tick must never throw on a
 * malformed entry it cannot fix).
 */
export function parseScheduleTriggers(
  routineSlug: string,
  config: Record<string, unknown>
): RoutineScheduleTrigger[] {
  const triggers = Array.isArray(config["x-triggers"]) ? config["x-triggers"] : [];
  const specs: RoutineScheduleTrigger[] = [];

  triggers.forEach((entry: unknown, triggerIndex: number) => {
    if (!isRecord(entry)) return;
    const type = entry.type;
    if (typeof type !== "string" || !SCHEDULE_TYPES.has(type as ScheduleType)) return;

    const deduplicationKey = `${routineSlug}:${triggerIndex}`;
    const base = { ...FIXED_POLICY, timezone: "UTC", deduplicationKey };

    if (type === "cron" && typeof entry.schedule === "string") {
      specs.push({
        triggerIndex,
        spec: {
          type: "cron",
          expression: entry.schedule,
          ...base,
          timezone: typeof entry.timezone === "string" ? entry.timezone : "UTC",
        },
      });
    } else if (type === "interval" && typeof entry.everyMs === "number") {
      specs.push({
        triggerIndex,
        spec: {
          type: "interval",
          everyMs: entry.everyMs,
          startAt: typeof entry.startAt === "string" ? entry.startAt : undefined,
          ...base,
        },
      });
    } else if (type === "datetime" && typeof entry.at === "string") {
      specs.push({
        triggerIndex,
        spec: { type: "datetime", at: entry.at, ...base },
      });
    }
  });

  return specs;
}
