import {
  calendarEventOverlaps,
  parseCalendarRead,
  type CalendarEvent,
  type CalendarRead,
} from '@tulipfarm/google-workspace/calendar-events';

export async function readUpcomingCalendar(
  read: (operation: CalendarRead, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
  now = Date.now(),
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  let calendarTimeZone: string | null = null;
  const until = now + 12 * 60 * 60 * 1000;
  for (let page = 0; page < 12; page++) {
    deadline.throwIfAborted();
    const operation: CalendarRead = {
      kind: 'calendar.events.list',
      calendarId: 'primary',
      timeMin: new Date(now).toISOString(),
      timeMax: new Date(until).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 3,
      ...(pageToken ? { pageToken } : {}),
    };
    const result = parseCalendarRead(operation, await read(operation, deadline));
    deadline.throwIfAborted();
    if (calendarTimeZone && result.calendarTimeZone !== calendarTimeZone) throw new Error('Calendar timezone changed');
    calendarTimeZone = result.calendarTimeZone;
    for (const event of result.events) {
      if (!seen.has(event.eventId) && calendarEventOverlaps(event, now, until, calendarTimeZone)) events.push(event);
      seen.add(event.eventId);
    }
    if (events.length >= 3 || !result.nextPageToken) return { events: events.slice(0, 3), calendarTimeZone };
    if (tokens.has(result.nextPageToken)) throw new Error('Calendar repeated a page');
    tokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
  throw new Error('Calendar page limit reached');
}
