const day = 86400000;

function zoneOffset(time: number, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(time)
      .map(part => [part.type, Number(part.value)]),
  );
  const wall = new Date(0);
  wall.setUTCFullYear(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1);
  wall.setUTCHours(parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  return wall.getTime() - Math.floor(time / 1000) * 1000;
}

/** The `datetime-local` value showing an instant as wall-clock time in a zone. */
export const zonedInput = (time: number, zone: string) =>
  new Date(time + zoneOffset(time, zone)).toISOString().slice(0, 16);

/** The instant for a `datetime-local` value read in a zone. A repeated time takes its earlier instant; a skipped time moves forward by the gap. */
export function fromZonedInput(value: string, zone: string) {
  const wall = Date.parse(`${value}:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !Number.isFinite(wall)) return NaN;
  const before = zoneOffset(wall - day, zone),
    after = zoneOffset(wall + day, zone);
  const matching = [wall - before, wall - after].filter(time => zonedInput(time, zone) === value);
  return matching.length ? Math.min(...matching) : wall - before;
}
