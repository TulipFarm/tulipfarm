import { canonicalHash, type trigger as triggerSchema } from "@tulipfarm/schema";
import {
  type BusinessCalendar,
  isCalendarOpenAt,
  localPartsAt,
  type ZonedParts,
  zonedPartsToUtc,
} from "./calendar";

/**
 * Deterministic planner for `datetime`, `interval`, and `cron` Triggers.
 *
 * The planner is a pure function of the authored schedule, the durable schedule State, and the
 * caller's clock reading: the same three inputs always produce the same occurrences, the same
 * deduplication keys, and the same jitter. Nothing here reads the wall clock or dispatches — the
 * caller persists the returned occurrences and enqueues them.
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
  /** `datetime` only: the single authored instant. */
  readonly at?: string;
  /** `interval` only: the fixed UTC period. */
  readonly everyMs?: number;
  /** `cron` only: a five-field expression evaluated in `timezone`. */
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
  /** The Trigger's deduplication key; every occurrence key is derived from it. */
  readonly deduplicationKey: string;
}

/** What the durable store knows about this Trigger when the planner runs. */
export interface ScheduleState {
  /** The newest occurrence already planned, or `null` if the Trigger has never fired. */
  readonly lastScheduledForMs: number | null;
  readonly activeRuns: number;
}

export interface ScheduledFire {
  /** The occurrence's canonical instant — the identity the Run is deduplicated on. */
  readonly scheduledForMs: number;
  /** When to actually start, after deterministic jitter. */
  readonly effectiveAtMs: number;
  readonly deduplicationKey: string;
  /** True when the occurrence is older than the current one, i.e. a backfill. */
  readonly catchUp: boolean;
  /** True when this occurrence displaces an in-flight Run under `supersede`. */
  readonly supersede: boolean;
}

export interface SchedulePlan {
  readonly fires: readonly ScheduledFire[];
  /** Occurrences that were due but deliberately not fired, by policy or by calendar. */
  readonly skipped: number;
  readonly nextDueAtMs: number | null;
}

/** How far back a single planner pass will look for missed occurrences. */
export const CATCH_UP_HORIZON_MS = 7 * 86_400_000;
/** How far ahead the planner will search for the next occurrence before giving up. */
export const LOOKAHEAD_HORIZON_MS = 400 * 86_400_000;
const MAX_SCAN_STEPS = 200_000;

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

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

/** The first instant after a spring-forward gap, i.e. the moment the skipped hour ends. */
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

/** Next matching occurrence(s) strictly after `afterMs`; two only for a repeated hour. */
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

// ---------------------------------------------------------------------------
// occurrence enumeration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

/**
 * Plan the occurrences a scheduled Trigger owes as of `nowMs`.
 *
 * Missed occurrences are resolved against the authored `missedRunPolicy`: `skip` runs only the
 * current occurrence, `run_once` runs it once and marks it a catch-up, and `catch_up_bounded`
 * backfills at most `catchUpCap` occurrences oldest-first. Everything not fired is counted in
 * `skipped` rather than silently dropped, so the caller can record why a Run never happened.
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
