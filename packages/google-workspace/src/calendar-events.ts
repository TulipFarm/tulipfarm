import { z } from 'zod';
import { googleOperationSchema, type GoogleOperation } from './operation-contracts.ts';

export const calendarInstantSchema = z.iso.datetime({ offset: true }).brand<'CalendarInstant'>();
const localDate = z.iso.date().brand<'CalendarDate'>();
const httpsUrl = z
  .url()
  .refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  })
  .brand<'CalendarUrl'>();
const timeZone = z.string().refine(value => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
});
export const calendarEventSchema = z.object({
  calendarId: z.string().min(1),
  eventId: z.string().min(1),
  title: z.string().nullable(),
  time: z.discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('timed'), startsAt: calendarInstantSchema, endsAt: calendarInstantSchema })
      .refine(value => Date.parse(value.endsAt) > Date.parse(value.startsAt)),
    z
      .object({ kind: z.literal('all-day'), startsOn: localDate, endsBefore: localDate })
      .refine(value => value.endsBefore > value.startsOn),
  ]),
  joinUrl: httpsUrl.nullable(),
  eventUrl: httpsUrl.nullable(),
  attendees: z
    .array(z.object({ email: z.string(), displayName: z.string().optional(), responseStatus: z.string().optional() }))
    .optional(),
  timeZone: timeZone.nullable().optional(),
  location: z.string().optional(),
  conferenceStatus: z.enum(['pending', 'success', 'failure']).optional(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarRead = Extract<GoogleOperation, { kind: 'calendar.events.list' | 'calendar.events.get' }>;
export const calendarReadCallSchema = z
  .strictObject({ tool: z.literal('google.read'), operation: googleOperationSchema })
  .refine(value => value.operation.kind === 'calendar.events.list' || value.operation.kind === 'calendar.events.get');
export function isCalendarReadCall(name: string, call: unknown): boolean {
  return name === 'google.read' && calendarReadCallSchema.safeParse(call).success;
}
export const calendarHistoryResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('events'),
    callId: z.uuid(),
    requestedAt: calendarInstantSchema,
    events: z.array(calendarEventSchema),
    continuation: z.enum(['complete', 'more-available']),
  }),
  z.object({ kind: z.literal('unavailable'), callId: z.uuid() }),
]);
export type CalendarHistoryResult = z.infer<typeof calendarHistoryResultSchema>;
const providerTime = z.union([
  z.object({ dateTime: calendarInstantSchema, timeZone: timeZone.optional() }),
  z.object({ date: localDate }),
]);
const providerEvent = z.object({
  error: z.never().optional(),
  id: z.string().min(1),
  summary: z.string().optional(),
  status: z.string().optional(),
  start: providerTime,
  end: providerTime,
  hangoutLink: z.unknown().optional(),
  htmlLink: z.unknown().optional(),
  attendees: calendarEventSchema.shape.attendees,
  location: z.string().optional(),
  conferenceData: z
    .object({
      entryPoints: z.array(z.object({ entryPointType: z.string(), uri: z.unknown().optional() })).optional(),
      createRequest: z
        .object({ status: z.object({ statusCode: z.enum(['pending', 'success', 'failure']) }).optional() })
        .optional(),
    })
    .optional(),
});
const providerPage = z.object({
  error: z.never().optional(),
  kind: z.literal('calendar#events').optional(),
  items: z.array(z.unknown()).default([]),
  timeZone: timeZone.optional(),
  nextPageToken: z.string().min(1).max(2048).optional(),
});
const safeUrl = (value: unknown) => {
  const parsed = httpsUrl.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export function parseCalendarRead(read: CalendarRead, data: unknown) {
  const page = read.kind === 'calendar.events.list' ? providerPage.parse(data) : { items: [data] };
  if (
    read.kind === 'calendar.events.list' &&
    !z.object({ items: z.array(z.unknown()) }).safeParse(data).success &&
    !z.object({ kind: z.literal('calendar#events') }).safeParse(data).success
  )
    throw new Error('Invalid calendar response');
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  for (const item of page.items) {
    if (z.object({ status: z.literal('cancelled') }).safeParse(item).success) continue;
    const event = providerEvent.parse(item);
    if (read.kind === 'calendar.events.get' && event.id !== read.eventId)
      throw new Error('Calendar event identity changed');
    const time =
      'dateTime' in event.start && 'dateTime' in event.end
        ? { kind: 'timed', startsAt: event.start.dateTime, endsAt: event.end.dateTime }
        : 'date' in event.start && 'date' in event.end
          ? { kind: 'all-day', startsOn: event.start.date, endsBefore: event.end.date }
          : null;
    const parsed = calendarEventSchema.parse({
      calendarId: read.calendarId,
      eventId: event.id,
      title: event.summary?.trim() || null,
      time,
      joinUrl:
        safeUrl(event.hangoutLink) ??
        event.conferenceData?.entryPoints
          ?.filter(entry => entry.entryPointType === 'video')
          .map(entry => safeUrl(entry.uri))
          .find(Boolean) ??
        null,
      eventUrl: safeUrl(event.htmlLink),
      ...(event.attendees && { attendees: event.attendees }),
      ...(event.location !== undefined && { location: event.location }),
      ...('dateTime' in event.start &&
        (event.start.timeZone ?? page.timeZone) && { timeZone: event.start.timeZone ?? page.timeZone }),
      ...(event.conferenceData?.createRequest?.status?.statusCode && {
        conferenceStatus: event.conferenceData.createRequest.status.statusCode,
      }),
    });
    if (!seen.has(event.id)) events.push(parsed);
    seen.add(event.id);
  }
  return { events, calendarTimeZone: page.timeZone ?? null, nextPageToken: page.nextPageToken ?? null };
}

function dateInZone(instant: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}
export function calendarEventOverlaps(event: CalendarEvent, start: number, end: number, zone: string | null): boolean {
  if (event.time.kind === 'timed')
    return Date.parse(event.time.endsAt) > start && Date.parse(event.time.startsAt) < end;
  if (!zone) throw new Error('Calendar timezone missing');
  return event.time.endsBefore > dateInZone(start, zone) && event.time.startsOn <= dateInZone(end - 1, zone);
}
