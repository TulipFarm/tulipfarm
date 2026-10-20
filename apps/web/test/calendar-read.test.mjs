import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readUpcomingCalendar } from '../src/features/integrations/calendar-read.ts';
const now = Date.parse('2026-10-02T10:00:00Z');
const event = (id, start, end) => ({ id, summary: id, start: { dateTime: start }, end: { dateTime: end } });
test('upcoming calendar traverses empty and short pages under fixed bounds and returns earliest three', async () => {
  const calls = [];
  const pages = [
    { items: [event('ongoing', '2026-10-02T09:00:00Z', '2026-10-02T11:00:00Z')], nextPageToken: 'second' },
    { items: [], nextPageToken: 'third' },
    {
      items: [
        event('next', '2026-10-02T12:00:00Z', '2026-10-02T13:00:00Z'),
        event('later', '2026-10-02T14:00:00Z', '2026-10-02T15:00:00Z'),
        event('fourth', '2026-10-02T16:00:00Z', '2026-10-02T17:00:00Z'),
      ],
    },
  ];
  const result = await readUpcomingCalendar(
    async call => {
      calls.push(call);
      return pages.shift();
    },
    new AbortController().signal,
    now,
  );
  assert.deepEqual(
    result.events.map(event => event.eventId),
    ['ongoing', 'next', 'later'],
  );
  assert.deepEqual(
    calls.map(call => [call.timeMin, call.timeMax, call.pageToken]),
    [
      ['2026-10-02T10:00:00.000Z', '2026-10-02T22:00:00.000Z', undefined],
      ['2026-10-02T10:00:00.000Z', '2026-10-02T22:00:00.000Z', 'second'],
      ['2026-10-02T10:00:00.000Z', '2026-10-02T22:00:00.000Z', 'third'],
    ],
  );
  await assert.rejects(
    readUpcomingCalendar(async () => ({ items: [], nextPageToken: 'loop' }), new AbortController().signal, now),
    /repeated/,
  );
  let index = 0;
  await assert.rejects(
    readUpcomingCalendar(
      async () => ({ items: [], nextPageToken: String(index++) }),
      new AbortController().signal,
      now,
    ),
    /limit/,
  );
});
