/** Use `Intl` IANA zones so authored wall-clock schedules survive DST changes. */

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

export interface LocalParts extends ZonedParts {
  readonly weekday: number;
}

export interface BusinessCalendar {
  readonly id: string;
  readonly timezone: string;
  readonly openWeekdays: readonly number[];
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

/** Returns 0, 1, or 2 matching instants for DST gap, ordinary time, or repeated hour. */
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

export function localDateKey(instantMs: number, timezone: string): string {
  const { year, month, day } = localPartsAt(instantMs, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isCalendarOpenAt(calendar: BusinessCalendar, instantMs: number): boolean {
  const { weekday } = localPartsAt(instantMs, calendar.timezone);
  if (!calendar.openWeekdays.includes(weekday)) return false;
  return !calendar.closedDates.includes(localDateKey(instantMs, calendar.timezone));
}
