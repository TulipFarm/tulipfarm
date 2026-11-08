const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Stored timestamps are UTC instants; people read them in their own locale and time zone. */
export function formatTimestamp(value: string, locale?: string, timeZone?: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(time);
}

/** Date fields are calendar days with no zone, so they format in UTC to avoid shifting to the day before or after. */
export function formatCalendarDate(value: string, locale?: string): string {
  const match = calendarDate.exec(value);
  if (!match) return value;
  const day = new Date(0);
  day.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const time = day.getTime();
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(time);
}
