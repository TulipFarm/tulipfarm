import { z } from 'zod';
import { workflowCalendarSchema } from '@tulipfarm/workflows/calendar-contracts';
import { agentCalendarSchema } from '@tulipfarm/agents/schedule-contracts';
import { taskSummarySchema } from '@tulipfarm/agents/task-contracts';
import { parseCalendarRead } from '@tulipfarm/google-workspace/calendar-events';
import { googleAppScopes, type GoogleStatus } from '@tulipfarm/google-workspace/public-contracts';
import { googleApi, googleError, googleAccessLost } from '@/lib/google-workspace';
import { workflowRequest } from '@/features/workflows/api';
import { taskApi } from '@/features/tasks/api';
import { TableRequestError } from '@/features/tables/request-state';
import type { CalendarItem } from './model';

export const providerCalendarSchema = z.object({
  id: z.string(),
  summary: z.string(),
  timeZone: z.string(),
  accessRole: z.enum(['freeBusyReader', 'reader', 'writer', 'owner']),
  primary: z.boolean().optional(),
});
export type ProviderCalendar = z.infer<typeof providerCalendarSchema>;
const calendarsPage = z.object({ items: z.array(providerCalendarSchema), nextPageToken: z.string().optional() });
const busyFields = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        transparency: z.string().optional(),
        eventType: z.string().optional(),
        attendees: z
          .array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() }))
          .optional(),
      }),
    )
    .default([]),
});
export type GoogleCalendarFeed = {
  calendars: ProviderCalendar[];
  items: CalendarItem[];
  errors: { id: string; message: string }[];
  complete: boolean;
  loadedAt: number;
};
export async function readGoogleCalendar(
  workspaceId: string,
  status: GoogleStatus,
  range: { from: string; to: string },
  signal: AbortSignal,
): Promise<GoogleCalendarFeed> {
  if (status.status !== 'connected' || !status.scopes.includes(googleAppScopes.calendar[0]))
    throw new Error('Connect Google Calendar to read events.');
  const expectedIntegration = {
    integrationId: status.integrationId,
    accountId: status.accountId,
    generation: status.generation,
    scopes: status.scopes,
  };
  const calendars: ProviderCalendar[] = [],
    items: CalendarItem[] = [],
    errors: GoogleCalendarFeed['errors'] = [];
  let pageToken: string | undefined;
  const seenPages = new Set<string>();
  for (let index = 0; index < 20; index++) {
    const result = calendarsPage.parse(
      (
        await googleApi.read(
          workspaceId,
          {
            expectedIntegration,
            operation: { kind: 'calendar.calendars.list', maxResults: 100, ...(pageToken ? { pageToken } : {}) },
          },
          signal,
        )
      ).data,
    );
    calendars.push(...result.items.filter(item => item.accessRole !== 'freeBusyReader'));
    if (result.items.some(item => item.accessRole === 'freeBusyReader'))
      errors.push({
        id: 'availability-only',
        message: 'Some calendars allow busy-time access only. Their availability is not included.',
      });
    pageToken = result.nextPageToken;
    if (!pageToken) break;
    if (seenPages.has(pageToken)) throw new Error('Google repeated a calendar page. Reload calendars.');
    seenPages.add(pageToken);
  }
  if (pageToken)
    errors.push({ id: 'calendar-limit', message: 'Not all calendars loaded. Availability is incomplete.' });
  for (const calendar of calendars) {
    try {
      let token: string | undefined;
      const seen = new Set<string>(),
        eventIds = new Set<string>();
      for (let page = 0; page < 50; page++) {
        signal.throwIfAborted();
        const operation = {
          kind: 'calendar.events.list' as const,
          calendarId: calendar.id,
          timeMin: range.from,
          timeMax: range.to,
          singleEvents: true,
          orderBy: 'startTime' as const,
          maxResults: 100,
          ...(token ? { pageToken: token } : {}),
        };
        const data = (await googleApi.read(workspaceId, { operation, expectedIntegration }, signal)).data;
        const result = parseCalendarRead(operation, data),
          availability = busyFields.parse(data);
        for (const event of result.events) {
          if (eventIds.has(event.eventId)) continue;
          eventIds.add(event.eventId);
          const raw = availability.items.find(item => item.id === event.eventId);
          const task = raw?.eventType === 'focusTime';
          items.push({
            id: `google:${calendar.id}:${event.eventId}`,
            title: event.title ?? 'Untitled event',
            kind: task ? 'task' : 'meeting',
            source: calendar.summary,
            sourceId: calendar.id,
            status: raw?.attendees?.some(person => person.self && person.responseStatus === 'declined')
              ? 'Declined'
              : 'Confirmed',
            time:
              event.time.kind === 'timed'
                ? { kind: 'timed', start: event.time.startsAt, end: event.time.endsAt }
                : {
                    kind: 'all-day',
                    start: event.time.startsOn,
                    end: event.time.endsBefore,
                    zone: result.calendarTimeZone ?? calendar.timeZone,
                  },
            busy:
              raw?.transparency !== 'transparent' &&
              !raw?.attendees?.some(person => person.self && person.responseStatus === 'declined'),
            ...(event.eventUrl ? { href: event.eventUrl } : {}),
            ...(event.joinUrl ? { joinUrl: event.joinUrl } : {}),
            ...(event.location ? { location: event.location } : {}),
            tags: [task ? 'Focus time' : 'Google Calendar'],
          });
        }
        token = result.nextPageToken ?? undefined;
        if (!token) break;
        if (seen.has(token)) throw new Error('Google repeated an event page.');
        seen.add(token);
      }
      if (token)
        errors.push({ id: calendar.id, message: `${calendar.summary}: not all events loaded. Choose a shorter view.` });
    } catch (error) {
      if (signal.aborted || googleAccessLost(error)) throw error;
      errors.push({ id: calendar.id, message: `${calendar.summary}: ${googleError(error)}` });
    }
  }
  return { calendars, items, errors, complete: errors.length === 0, loadedAt: Date.now() };
}
export const calendarApi = {
  workflows: async (workspaceId: string, range: { from: string; to: string }, signal: AbortSignal) =>
    workflowCalendarSchema.parse(
      await workflowRequest(
        `/workspaces/${workspaceId}/workflows/calendar?${new URLSearchParams(range)}`,
        'GET',
        undefined,
        signal,
      ),
    ),
  agents: async (workspaceId: string, range: { from: string; to: string }, signal: AbortSignal) =>
    agentCalendarSchema.parse(
      await workflowRequest(
        `/workspaces/${workspaceId}/agents/calendar?${new URLSearchParams(range)}`,
        'GET',
        undefined,
        signal,
      ),
    ),
  follow: (workspaceId: string, workflowId: string, following: boolean) =>
    workflowRequest(`/workspaces/${workspaceId}/workflows/${workflowId}/calendar-follow`, 'PUT', { following }),
  tasks: async (workspaceId: string, after: string | null, signal: AbortSignal) => {
    const result = z
      .object({ tasks: taskSummarySchema.array(), nextCursor: z.string().nullable() })
      .parse(
        await workflowRequest(
          `/workspaces/${workspaceId}/agent-tasks?state=active&limit=25${after ? `&after=${after}` : ''}`,
          'GET',
          undefined,
          signal,
        ),
      );
    const tasks = [];
    for (const task of result.tasks) {
      try {
        const history = await taskApi(workspaceId).history(task.id, signal);
        const text = history.messages
          .find(message => message.role === 'owner')
          ?.text.replace(/\s+/g, ' ')
          .trim();
        tasks.push({ id: task.id, title: text ? text.slice(0, 160) : 'Private agent task', status: task.status });
      } catch (error) {
        if (error instanceof TableRequestError && [403, 404].includes(error.status)) continue;
        throw error;
      }
    }
    return { tasks, nextCursor: result.nextCursor };
  },
};
