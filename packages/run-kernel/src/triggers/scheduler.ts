import { canonicalHash, type trigger as triggerSchema } from "@tulipfarm/schema";
import {
  type BusinessCalendar,
  isCalendarOpenAt,
  localPartsAt,
  type ZonedParts,
  zonedPartsToUtc,
} from "./calendar";

/**
 * Schedule planning is pure over authored schedule, durable state, and caller clock; it does not
 * read the wall clock or dispatch.
 */

export type ScheduleType = "datetime" | "interval" | "cron";
export type DstPolicy = "forward_only" | "skip_missing" | "run_repeated";
export type MissedRunPolicy = "skip" | "run_once" | "catch_up_bounded";
export type OverlapPolicy = "skip" | "allow" | "supersede";

export type ScheduleErrorCode =
  | "catch_up_cap_missing"
  | "cron_expression_invalid"
  | "cron_expression_missing"
  | "datetime_instant_missing"
  | "interval_anchor_missing"
  | "interval_period_missing"
  | "not_a_schedule";

/** A schedule denial. Carries only `code:subject` — never an authored value. */
export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    readonly subject: string
  ) {
    super(`${code}:${subject}`);
    this.name = "ScheduleError";
  }
}

export interface ScheduleSpec {
  readonly type: ScheduleType;
  readonly at?: string;
  readonly everyMs?: number;
  readonly expression?: string;
  readonly timezone: string;
  readonly dstPolicy: DstPolicy;
  readonly missedRunPolicy: MissedRunPolicy;
  readonly catchUpCap?: number;
  readonly overlapPolicy: OverlapPolicy;
  readonly jitterMs?: number;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly calendar?: BusinessCalendar;
  readonly deduplicationKey: string;
}

export interface ScheduleState {
  readonly lastScheduledForMs: number | null;
  readonly activeRuns: number;
}

export interface ScheduledFire {
  readonly scheduledForMs: number;
  readonly effectiveAtMs: number;
  readonly deduplicationKey: string;
  readonly catchUp: boolean;
  readonly supersede: boolean;
}

export interface SchedulePlan {
  readonly fires: readonly ScheduledFire[];
  readonly skipped: number;
  readonly nextDueAtMs: number | null;
}

export const CATCH_UP_HORIZON_MS = 7 * 86_400_000;
export const LOOKAHEAD_HORIZON_MS = 400 * 86_400_000;
const MAX_SCAN_STEPS = 200_000;

interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  /** `null` means unrestricted (`*`), which selects the standard day-of-month/day-of-week OR. */
  readonly dayOfMonth: ReadonlySet<number> | null;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number> | null;
}

function parseCronField(text: string, min: number, max: number): ReadonlySet<number> | null {
  if (text === "*") return null;

  const values = new Set<number>();
  for (const term of text.split(",")) {
    const [range, stepText] = term.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return new Set();

    let from = min;
    let to = max;
    if (range !== "*" && range !== undefined) {
      const [fromText, toText] = range.split("-");
      from = Number(fromText);
      to = toText === undefined ? (stepText === undefined ? from : max) : Number(toText);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      return new Set();
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function parseCron(expression: string, subject: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError("cron_expression_invalid", subject);

  const minute = parseCronField(parts[0] ?? "", 0, 59);
  const hour = parseCronField(parts[1] ?? "", 0, 23);
  const dayOfMonth = parseCronField(parts[2] ?? "", 1, 31);
  const month = parseCronField(parts[3] ?? "", 1, 12);
  const dayOfWeek = parseCronField(parts[4] ?? "", 0, 7);

  const fields = {
    minute: minute ?? allValues(0, 59),
    hour: hour ?? allValues(0, 23),
    dayOfMonth,
    month: month ?? allValues(1, 12),
    dayOfWeek: dayOfWeek === null ? null : new Set([...dayOfWeek].map((day) => day % 7)),
  };
  for (const set of [fields.minute, fields.hour, fields.month, dayOfMonth, dayOfWeek]) {
    if (set !== null && set.size === 0) throw new ScheduleError("cron_expression_invalid", subject);
  }
  return fields;
}

function allValues(min: number, max: number): ReadonlySet<number> {
  const values = new Set<number>();
  for (let value = min; value <= max; value += 1) values.add(value);
  return values;
}

function matchesDay(fields: CronFields, date: Date): boolean {
  const dayOfMonthMatch = fields.dayOfMonth?.has(date.getUTCDate()) ?? null;
  const dayOfWeekMatch = fields.dayOfWeek?.has(date.getUTCDay()) ?? null;
  if (dayOfMonthMatch === null && dayOfWeekMatch === null) return true;
  if (dayOfMonthMatch === null) return dayOfWeekMatch === true;
  if (dayOfWeekMatch === null) return dayOfMonthMatch;
  // Standard cron: when both fields are restricted, either one matching is enough.
  return dayOfMonthMatch || dayOfWeekMatch;
}

function offsetAt(instantMs: number, timezone: string): number {
  const parts = localPartsAt(instantMs, timezone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    Math.floor(instantMs / 60_000) * 60_000
  );
}

function gapEndInstant(parts: ZonedParts, timezone: string): number {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let low = asUtc - 86_400_000;
  let high = asUtc + 86_400_000;
  const target = offsetAt(high, timezone);

  while (high - low > 60_000) {
    const mid = low + Math.floor((high - low) / 120_000) * 60_000;
    if (mid <= low) break;
    if (offsetAt(mid, timezone) === target) high = mid;
    else low = mid;
  }
  return high;
}

/** Resolve one authored wall-clock occurrence into the instants it actually fires at. */
function resolveDst(parts: ZonedParts, timezone: string, dstPolicy: DstPolicy): readonly number[] {
  const instants = zonedPartsToUtc(parts, timezone);
  if (instants.length === 0) {
    return dstPolicy === "skip_missing" ? [] : [gapEndInstant(parts, timezone)];
  }
  if (instants.length > 1 && dstPolicy !== "run_repeated") return [instants[0] as number];
  return instants;
}

function nextCronFires(fields: CronFields, spec: ScheduleSpec, afterMs: number): readonly number[] {
  const from = localPartsAt(afterMs, spec.timezone);
  let cursor = Date.UTC(from.year, from.month - 1, from.day, from.hour, from.minute) + 60_000;
  const limit = cursor + LOOKAHEAD_HORIZON_MS;

  for (let step = 0; step < MAX_SCAN_STEPS && cursor < limit; step += 1) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();

    if (!fields.month.has(month + 1)) {
      cursor = Date.UTC(year, month + 1, 1);
      continue;
    }
    if (!matchesDay(fields, date)) {
      cursor = Date.UTC(year, month, date.getUTCDate() + 1);
      continue;
    }
    if (!fields.hour.has(date.getUTCHours())) {
      cursor = Date.UTC(year, month, date.getUTCDate(), date.getUTCHours() + 1);
      continue;
    }
    if (!fields.minute.has(date.getUTCMinutes())) {
      cursor += 60_000;
      continue;
    }

    const instants = resolveDst(
      {
        year,
        month: month + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
      },
      spec.timezone,
      spec.dstPolicy
    ).filter((instant) => instant > afterMs);
    cursor += 60_000;
    if (instants.length > 0) return instants;
  }
  return [];
}

function requireInstant(value: string | undefined, code: ScheduleErrorCode, subject: string) {
  if (value === undefined) throw new ScheduleError(code, subject);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new ScheduleError(code, subject);
  return parsed;
}

function enumerateOccurrences(
  spec: ScheduleSpec,
  afterMs: number,
  untilMs: number,
  limit: number
): readonly number[] {
  const subject = spec.deduplicationKey;
  const occurrences: number[] = [];

  if (spec.type === "datetime") {
    const instant = requireInstant(spec.at, "datetime_instant_missing", subject);
    if (instant > afterMs && instant <= untilMs) occurrences.push(instant);
    return occurrences;
  }

  if (spec.type === "interval") {
    if (spec.everyMs === undefined || spec.everyMs <= 0) {
      throw new ScheduleError("interval_period_missing", subject);
    }
    const anchor = requireInstant(spec.startAt, "interval_anchor_missing", subject);
    const skipped = afterMs < anchor ? 0 : Math.floor((afterMs - anchor) / spec.everyMs) + 1;
    for (let index = skipped; occurrences.length < limit; index += 1) {
      const instant = anchor + index * spec.everyMs;
      if (instant > untilMs) break;
      if (instant > afterMs) occurrences.push(instant);
    }
    return occurrences;
  }

  if (spec.expression === undefined) throw new ScheduleError("cron_expression_missing", subject);
  const fields = parseCron(spec.expression, subject);
  let cursor = afterMs;
  while (occurrences.length < limit) {
    const next = nextCronFires(fields, spec, cursor);
    if (next.length === 0) break;
    cursor = Math.max(...next);
    for (const instant of next) {
      if (instant > untilMs) return occurrences;
      occurrences.push(instant);
    }
  }
  return occurrences;
}

function isEligible(spec: ScheduleSpec, instant: number, windowStart: number, windowEnd: number) {
  if (instant < windowStart || instant > windowEnd) return false;
  return spec.calendar === undefined || isCalendarOpenAt(spec.calendar, instant);
}

function jitterFor(spec: ScheduleSpec, scheduledForMs: number): number {
  if (spec.jitterMs === undefined || spec.jitterMs <= 0) return 0;
  const digest = canonicalHash([spec.deduplicationKey, scheduledForMs]);
  return Number.parseInt(digest.slice(0, 8), 16) % spec.jitterMs;
}

/**
 * Missed schedules obey `missedRunPolicy`; unfired occurrences are counted as `skipped`, not lost.
 */
export function planSchedule(
  spec: ScheduleSpec,
  state: ScheduleState,
  nowMs: number
): SchedulePlan {
  const subject = spec.deduplicationKey;
  if (spec.missedRunPolicy === "catch_up_bounded") {
    if (spec.catchUpCap === undefined || spec.catchUpCap < 1) {
      throw new ScheduleError("catch_up_cap_missing", subject);
    }
  }

  const windowStart =
    spec.startAt === undefined
      ? Number.NEGATIVE_INFINITY
      : requireInstant(spec.startAt, "datetime_instant_missing", subject);
  const windowEnd =
    spec.endAt === undefined
      ? Number.POSITIVE_INFINITY
      : requireInstant(spec.endAt, "datetime_instant_missing", subject);

  const floor = Number.isFinite(windowStart) ? windowStart - 1 : nowMs - CATCH_UP_HORIZON_MS;
  const from = Math.max(state.lastScheduledForMs ?? floor, nowMs - CATCH_UP_HORIZON_MS);
  const cap = spec.catchUpCap ?? 1;

  const due = enumerateOccurrences(spec, from, nowMs, cap + 64).filter((instant) =>
    isEligible(spec, instant, windowStart, windowEnd)
  );
  const upcoming = enumerateOccurrences(
    spec,
    nowMs,
    Math.min(windowEnd, nowMs + LOOKAHEAD_HORIZON_MS),
    64
  ).find((instant) => isEligible(spec, instant, windowStart, windowEnd));

  let selected: readonly number[] = [];
  if (due.length > 0) {
    const current = due[due.length - 1] as number;
    selected =
      spec.missedRunPolicy === "catch_up_bounded"
        ? due.slice(Math.max(0, due.length - cap))
        : [current];
  }
  let skipped = due.length - selected.length;

  let supersede = false;
  if (state.activeRuns > 0 && selected.length > 0) {
    if (spec.overlapPolicy === "skip") {
      skipped += selected.length;
      selected = [];
    } else if (spec.overlapPolicy === "supersede") {
      skipped += selected.length - 1;
      selected = selected.slice(-1);
      supersede = true;
    }
  }

  const newest = selected[selected.length - 1];
  const fires = selected.map((scheduledForMs) => ({
    scheduledForMs,
    effectiveAtMs: scheduledForMs + jitterFor(spec, scheduledForMs),
    deduplicationKey: `${spec.deduplicationKey}:${scheduledForMs}`,
    catchUp: scheduledForMs !== newest || (spec.missedRunPolicy === "run_once" && due.length > 1),
    supersede,
  }));

  return { fires, skipped, nextDueAtMs: upcoming ?? null };
}

const SCHEDULE_TYPES: readonly string[] = ["datetime", "interval", "cron"];

/** Read the schedule out of an authored Trigger, applying the fail-closed defaults. */
export function scheduleSpecFromTrigger(
  definition: triggerSchema.TriggerDefinition,
  calendar?: BusinessCalendar
): ScheduleSpec {
  const spec = definition.spec;
  if (!SCHEDULE_TYPES.includes(spec.type)) {
    throw new ScheduleError("not_a_schedule", spec.deduplication.key);
  }
  if (spec.type === "datetime") {
    const policy = spec.schedule;
    return {
      type: spec.type,
      at: spec.at,
      timezone: policy?.timezone ?? "UTC",
      dstPolicy: policy?.dstPolicy ?? "forward_only",
      missedRunPolicy: policy?.missedRunPolicy ?? "skip",
      catchUpCap: policy?.catchUpCap,
      overlapPolicy: policy?.overlapPolicy ?? "skip",
      jitterMs: policy?.jitterMs,
      startAt: policy?.startAt,
      endAt: policy?.endAt,
      calendar,
      deduplicationKey: spec.deduplication.key,
    };
  }
  if (spec.type === "interval") {
    const policy = spec.schedule;
    return {
      type: spec.type,
      everyMs: spec.everyMs,
      timezone: policy?.timezone ?? "UTC",
      dstPolicy: policy?.dstPolicy ?? "forward_only",
      missedRunPolicy: policy?.missedRunPolicy ?? "skip",
      catchUpCap: policy?.catchUpCap,
      overlapPolicy: policy?.overlapPolicy ?? "skip",
      jitterMs: policy?.jitterMs,
      startAt: policy?.startAt,
      endAt: policy?.endAt,
      calendar,
      deduplicationKey: spec.deduplication.key,
    };
  }
  if (spec.type === "cron") {
    const policy = spec.schedule;
    return {
      type: spec.type,
      expression: spec.expression,
      timezone: policy?.timezone ?? spec.timezone ?? "UTC",
      dstPolicy: policy?.dstPolicy ?? "forward_only",
      missedRunPolicy: policy?.missedRunPolicy ?? "skip",
      catchUpCap: policy?.catchUpCap,
      overlapPolicy: policy?.overlapPolicy ?? "skip",
      jitterMs: policy?.jitterMs,
      startAt: policy?.startAt,
      endAt: policy?.endAt,
      calendar,
      deduplicationKey: spec.deduplication.key,
    };
  }
  throw new ScheduleError("not_a_schedule", spec.deduplication.key);
}
