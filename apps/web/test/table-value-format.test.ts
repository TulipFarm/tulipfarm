import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCalendarDate, formatTimestamp } from '../src/features/tables/value-format.ts';

test('timestamps read in the viewer locale and time zone, without ISO syntax', () => {
  assert.equal(formatTimestamp('2026-10-14T04:00:00.000Z', 'en-GB', 'Asia/Kolkata'), '14 Oct 2026, 09:30');
  assert.equal(
    formatTimestamp('2026-10-14T04:00:00.000Z', 'en-US', 'America/New_York').replace(/\s/g, ' '),
    'Oct 14, 2026, 12:00 AM',
  );
  assert.equal(formatTimestamp('2026-10-14T09:30:00+05:30', 'en-GB', 'Asia/Kolkata'), '14 Oct 2026, 09:30');
  assert.doesNotMatch(formatTimestamp('2026-10-14T04:00:00.000Z'), /\d{2}:\d{2}:\d{2}|T\d|Z$/);
});

test('timestamps that cannot be parsed are shown as stored', () => {
  assert.equal(formatTimestamp('not a date', 'en-GB', 'UTC'), 'not a date');
});

test('date-only values keep their calendar day in every time zone', () => {
  assert.equal(formatCalendarDate('2026-10-20', 'en-GB'), '20 Oct 2026');
  assert.equal(formatCalendarDate('2026-01-01', 'en-US'), 'Jan 1, 2026');
  assert.equal(formatCalendarDate('20 Oct', 'en-GB'), '20 Oct');
});
