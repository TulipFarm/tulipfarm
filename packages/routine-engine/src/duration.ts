const ISO_RE =
  /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * ISO-8601 duration → milliseconds. Years/months use calendar-free approximations
 * (365/30 days) — routine sleeps and timeouts are expected in the seconds-to-days range.
 * Throws on malformed input (the meta-schema should have caught it already).
 */
export function parseIsoDuration(iso: string): number {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`invalid ISO-8601 duration: ${iso}`);
  const [, years, months, weeks, days, hours, minutes, seconds] = m;
  const n = (v: string | undefined) => (v ? Number(v) : 0);
  return (
    n(years) * 365 * 86_400_000 +
    n(months) * 30 * 86_400_000 +
    n(weeks) * 7 * 86_400_000 +
    n(days) * 86_400_000 +
    n(hours) * 3_600_000 +
    n(minutes) * 60_000 +
    n(seconds) * 1_000
  );
}
