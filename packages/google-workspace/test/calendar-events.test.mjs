import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarEventOverlaps, parseCalendarRead, isCalendarReadCall } from '../src/calendar-events.ts';
import { googleOperationSchema } from '../src/operation-contracts.ts';
import { dispatchGoogleOperation } from '../src/operation-provider.ts';

const read = { kind: 'calendar.events.list', calendarId: 'primary' };
const event = {
  id: 'instance_1',
  summary: 'Review',
  start: { dateTime: '2026-10-02T09:00:00Z' },
  end: { dateTime: '2026-10-02T11:00:00Z' },
  hangoutLink: 'https://meet.google.com/abc',
  htmlLink: 'https://calendar.google.com/event?id=1',
};
test('calendar parsing keeps provider identity, dates and explicit safe links', () => {
  const page = parseCalendarRead(read, {
    items: [event, event, { id: 'cancelled', status: 'cancelled' }],
    timeZone: 'America/New_York',
    nextPageToken: 'next',
  });
  assert.deepEqual(page, {
    events: [
      {
        calendarId: 'primary',
        eventId: 'instance_1',
        title: 'Review',
        time: { kind: 'timed', startsAt: '2026-10-02T09:00:00Z', endsAt: '2026-10-02T11:00:00Z' },
        joinUrl: 'https://meet.google.com/abc',
        eventUrl: 'https://calendar.google.com/event?id=1',
        timeZone: 'America/New_York',
      },
    ],
    calendarTimeZone: 'America/New_York',
    nextPageToken: 'next',
  });
  const unsafe = parseCalendarRead(read, {
    items: [
      {
        ...event,
        hangoutLink: 'javascript:alert(1)',
        htmlLink: 'https://user:password@example.com',
        description: 'https://meet.google.com/invented',
      },
    ],
  }).events[0];
  assert.equal(unsafe.joinUrl, null);
  assert.equal(unsafe.eventUrl, null);
  const video = parseCalendarRead(read, {
    items: [
      {
        ...event,
        hangoutLink: undefined,
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'https://phone.example' },
            { entryPointType: 'video', uri: 'https://video.example/room' },
          ],
        },
      },
    ],
  }).events[0];
  assert.equal(video.joinUrl, 'https://video.example/room');
  for (const data of [
    {},
    { error: 'provider-failed' },
    { items: [{ ...event, start: { dateTime: '2026-02-30T09:00:00Z' } }] },
    { items: [{ ...event, end: event.start }] },
  ])
    assert.throws(() => parseCalendarRead(read, data));
  assert.throws(() =>
    parseCalendarRead({ kind: 'calendar.events.get', calendarId: 'primary', eventId: 'other' }, event),
  );
  assert.equal(
    isCalendarReadCall('google.read', { tool: 'google.read', operation: read, importSelection: '{}' }),
    false,
  );
});
test('calendar cards retain attendees, event timezone, location and conference progress', () => {
  for (const statusCode of ['pending', 'success', 'failure']) {
    const attendees = [{ email: 'guest@example.test', displayName: 'Guest', responseStatus: 'accepted' }];
    const parsed = parseCalendarRead(read, {
      timeZone: 'America/New_York',
      items: [
        {
          ...event,
          hangoutLink: undefined,
          start: { ...event.start, timeZone: 'Asia/Kolkata' },
          attendees,
          location: 'Studio',
          conferenceData: { createRequest: { status: { statusCode } } },
        },
      ],
    }).events[0];
    assert.deepEqual(parsed.attendees, attendees);
    assert.equal(parsed.timeZone, 'Asia/Kolkata');
    assert.equal(parsed.location, 'Studio');
    assert.equal(parsed.conferenceStatus, statusCode);
    assert.equal(parsed.joinUrl, null, 'a conference status never invents a link');
  }
});
test('calendar overlap includes ongoing events and honors exclusive boundaries and DST dates', () => {
  const parsed = parseCalendarRead(read, { items: [event] }).events[0];
  assert.equal(
    calendarEventOverlaps(parsed, Date.parse('2026-10-02T10:00:00Z'), Date.parse('2026-10-02T22:00:00Z'), null),
    true,
  );
  assert.equal(
    calendarEventOverlaps(parsed, Date.parse('2026-10-02T11:00:00Z'), Date.parse('2026-10-02T22:00:00Z'), null),
    false,
  );
  assert.equal(
    calendarEventOverlaps(parsed, Date.parse('2026-10-02T08:00:00Z'), Date.parse('2026-10-02T09:00:00Z'), null),
    false,
  );
  const allDay = parseCalendarRead(read, {
    items: [{ id: 'dst', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } }],
  }).events[0];
  assert.equal(allDay.time.startsOn, '2026-11-01');
  assert.equal(
    calendarEventOverlaps(
      allDay,
      Date.parse('2026-11-02T04:59:59Z'),
      Date.parse('2026-11-02T06:00:00Z'),
      'America/New_York',
    ),
    true,
  );
  assert.equal(
    calendarEventOverlaps(
      allDay,
      Date.parse('2026-11-02T05:00:00Z'),
      Date.parse('2026-11-02T06:00:00Z'),
      'America/New_York',
    ),
    false,
  );
});
test('start ordering is sent to Google only with recurrence expansion', async () => {
  assert.equal(googleOperationSchema.safeParse({ ...read, orderBy: 'startTime' }).success, false);
  const operation = {
    ...read,
    orderBy: 'startTime',
    singleEvents: true,
    timeMin: '2026-10-02T10:00:00Z',
    timeMax: '2026-10-02T22:00:00Z',
  };
  const result = await dispatchGoogleOperation({
    operation,
    accessToken: 'synthetic-token',
    fetcher: async url => {
      assert.equal(url.searchParams.get('orderBy'), 'startTime');
      assert.equal(url.searchParams.get('singleEvents'), 'true');
      assert.equal(url.searchParams.get('timeMin'), '2026-10-02T10:00:00Z');
      return Response.json({ items: [event] });
    },
  });
  assert.equal(parseCalendarRead(read, result).events[0].title, 'Review');
});
