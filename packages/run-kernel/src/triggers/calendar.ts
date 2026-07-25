/**
 * Timezone and business-calendar primitives for scheduled Triggers.
 *
 * Every conversion goes through the platform's IANA database via `Intl`, so a schedule authored
 * in a named zone keeps its wall-clock meaning across DST transitions instead of drifting with
 * the host's local offset.
 */

/** A wall-clock instant with no offset attached — meaningless until paired with a zone. */
export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** `ZonedParts` plus the day of week it landed on (0 = Sunday). */
export interface LocalParts extends ZonedParts {
  readonly weekday: number;
}

export interface BusinessCalendar {
  readonly id: string;
  readonly timezone: string;
  /** Days of week the business is open, 0 = Sunday. */
  readonly openWeekdays: readonly number[];
  /** Local `YYYY-MM-DD` dates the business is closed regardless of weekday. */
  readonly closedDates: readonly string[];
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached !== undefined) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  formatters.set(timezone, formatter);
  return formatter;
}

/** Read the wall-clock fields an instant carries in `timezone`. */
export function localPartsAt(instantMs: number, timezone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(instantMs)) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? 0,
  };
}

function offsetAt(instantMs: number, timezone: string): number {
  const parts = localPartsAt(instantMs, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUtc - Math.floor(instantMs / 60_000) * 60_000;
}

function sameWallClock(instantMs: number, timezone: string, parts: ZonedParts): boolean {
  const actual = localPartsAt(instantMs, timezone);
  return (
    actual.year === parts.year &&
    actual.month === parts.month &&
    actual.day === parts.day &&
    actual.hour === parts.hour &&
    actual.minute === parts.minute
  );
}

/**
 * Map a wall-clock time in `timezone` to the instants that actually carry it, earliest first.
 *
 * The result length is the DST answer the caller must act on: `0` for a spring-forward gap the
 * clock skipped, `1` for an ordinary time, `2` for a fall-back hour the clock repeated.
 */
export function zonedPartsToUtc(parts: ZonedParts, timezone: string): readonly number[] {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const found = new Set<number>();

  // Probe both sides of the day so a transition between the two offsets is never missed.
  for (const probe of [asUtc - 86_400_000, asUtc, asUtc + 86_400_000]) {
    const candidate = asUtc - offsetAt(probe, timezone);
    if (sameWallClock(candidate, timezone, parts)) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/** The local `YYYY-MM-DD` date an instant falls on in `timezone`. */
export function localDateKey(instantMs: number, timezone: string): string {
  const { year, month, day } = localPartsAt(instantMs, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whether the business is open at `instantMs`, judged in the calendar's own zone. */
export function isCalendarOpenAt(calendar: BusinessCalendar, instantMs: number): boolean {
  const { weekday } = localPartsAt(instantMs, calendar.timezone);
  if (!calendar.openWeekdays.includes(weekday)) return false;
  return !calendar.closedDates.includes(localDateKey(instantMs, calendar.timezone));
}
