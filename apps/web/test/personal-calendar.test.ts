import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ambiguousTime,
  calendarDays,
  calendarHourLabels,
  calendarNowNext,
  calendarRange,
  compactItemTime,
  dayKey,
  freeSlots,
  itemIsPast,
  itemOnDay,
  itemTime,
  layoutDay,
  layoutDayGroups,
  localDate,
  moveDate,
  type CalendarItem,
} from '../src/features/calendar/model.ts';

const meeting = (id: string, start: string, end: string, busy = true): CalendarItem => ({
  id,
  title: id,
  kind: 'meeting',
  source: 'Work',
  sourceId: 'work',
  status: 'Confirmed',
  busy,
  time: { kind: 'timed', start, end },
});
test('calendar views use local dates, Monday weeks, exclusive ends and DST-aware lengths', () => {
  assert.equal(calendarDays('2026-10-08', 'week', 'Asia/Kolkata')[0], '2026-10-05');
  assert.equal(calendarDays('2026-10-08', 'month', 'UTC').length, 35);
  assert.equal(calendarDays('2026-08-08', 'month', 'Asia/Kolkata').length, 42);
  assert.equal(calendarDays('2027-02-08', 'month', 'America/New_York').length, 28);
  const range = calendarRange('2026-03-08', 'day', 'America/New_York');
  assert.equal(Date.parse(range.to) - Date.parse(range.from), 23 * 3600000);
  assert.equal(moveDate('2026-01-31', 'month', 1, 'UTC'), '2026-02-28');
  assert.equal(dayKey(new Date('2026-10-05T23:00:00Z'), 'Asia/Kolkata'), '2026-10-06');
  assert.throws(() => localDate('2026-03-08', '02:30', 'America/New_York'));
  assert.equal(ambiguousTime(localDate('2026-11-01', '01:30', 'America/New_York'), 'America/New_York'), true);
});
test('all-day dates are exclusive and timed events split at local midnight', () => {
  const allDay: CalendarItem = {
    ...meeting('leave', '', ''),
    time: { kind: 'all-day', start: '2026-10-05', end: '2026-10-07' },
  };
  assert.equal(itemOnDay(allDay, '2026-10-06', 'Asia/Tokyo'), true);
  assert.equal(itemOnDay(allDay, '2026-10-07', 'Asia/Tokyo'), false);
  const overnight = meeting('overnight', '2026-10-05T23:30:00Z', '2026-10-06T01:00:00Z');
  assert.equal(itemOnDay(overnight, '2026-10-05', 'UTC'), true);
  assert.equal(itemOnDay(overnight, '2026-10-06', 'UTC'), true);
  assert.equal(layoutDay([overnight], '2026-10-06', 'UTC')[0]?.top, 0);
});
test('overlap lanes share width only within each overlap group', () => {
  const items = [
    meeting('a', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z'),
    meeting('b', '2026-10-05T09:30:00Z', '2026-10-05T10:30:00Z'),
    meeting('c', '2026-10-05T12:00:00Z', '2026-10-05T13:00:00Z'),
  ];
  assert.deepEqual(
    layoutDay(items, '2026-10-05', 'UTC').map(row => [row.column, row.columns]),
    [
      [0, 2],
      [1, 2],
      [0, 1],
    ],
  );
  const run: CalendarItem = {
    ...items[0]!,
    id: 'run',
    kind: 'agent',
    busy: false,
    time: { kind: 'point', at: '2026-10-05T09:30:00Z' },
  };
  assert.deepEqual(
    layoutDay([...items, run], '2026-10-05', 'UTC'),
    layoutDay(items, '2026-10-05', 'UTC'),
    'automation never receives duration or a meeting lane',
  );
  assert.deepEqual(layoutDay([run], '2026-10-05', 'UTC'), []);
});
test('compact event groups retain chained overlaps without merging adjacent periods', () => {
  const items = [
    meeting('a', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z'),
    meeting('b', '2026-10-05T09:30:00Z', '2026-10-05T10:30:00Z'),
    meeting('c', '2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z'),
    meeting('d', '2026-10-05T11:00:00Z', '2026-10-05T12:00:00Z'),
  ];
  const groups = layoutDayGroups(items, '2026-10-05', 'UTC');
  assert.deepEqual(
    groups.map(rows => rows.map(row => row.item.id)),
    [['a', 'b', 'c'], ['d']],
  );
  assert.deepEqual(groups.flat(), layoutDay(items, '2026-10-05', 'UTC'));
  assert.deepEqual(layoutDayGroups([], '2026-10-05', 'UTC'), []);
});
test('now and next use real time boundaries, selected items and local all-day dates', () => {
  const now = new Date('2026-10-05T09:30:00Z');
  const ended = meeting('ended', '2026-10-05T08:30:00Z', now.toISOString());
  const current = meeting('current', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
  const future = meeting('future', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z');
  const run: CalendarItem = {
    ...current,
    id: 'run',
    kind: 'agent',
    busy: false,
    time: { kind: 'point', at: '2026-10-05T09:45:00Z' },
  };
  assert.deepEqual(calendarNowNext([ended, run, future, current], now, 'UTC'), { current: [current], next: run });
  assert.deepEqual(calendarNowNext([ended, future], now, 'UTC'), { current: [], next: future });
  assert.deepEqual(
    calendarNowNext([run], new Date('2026-10-05T10:00:00Z'), 'UTC'),
    { current: [], next: null },
    'a past start is not evidence an agent is running',
  );
  const allDay: CalendarItem = { ...current, time: { kind: 'all-day', start: '2026-10-06', end: '2026-10-07' } };
  assert.deepEqual(calendarNowNext([allDay], new Date('2026-10-05T20:00:00Z'), 'Asia/Kolkata'), {
    current: [allDay],
    next: null,
  });
  assert.deepEqual(calendarNowNext([allDay], new Date('2026-10-06T20:00:00Z'), 'Asia/Kolkata'), {
    current: [],
    next: null,
  });
  assert.equal(itemIsPast(current, now, 'UTC'), false);
  assert.equal(itemIsPast(ended, now, 'UTC'), true);
  assert.equal(
    itemIsPast(run, new Date('2026-10-05T10:00:00Z'), 'UTC'),
    true,
    'an elapsed scheduled start is not a completion status',
  );
  assert.equal(itemIsPast(allDay, new Date('2026-10-06T20:00:00Z'), 'Asia/Kolkata'), true);
  assert.equal(itemTime(current, 'UTC'), '9:00 AM – 10:00 AM');
});
test('compact event times retain noon, midnight and zone distinctions', () => {
  assert.equal(
    compactItemTime(meeting('planning', '2026-10-05T09:30:00Z', '2026-10-05T10:30:00Z'), 'UTC'),
    '9:30–10:30a',
  );
  assert.equal(
    compactItemTime(meeting('noon', '2026-10-05T11:30:00Z', '2026-10-05T12:15:00Z'), 'UTC'),
    '11:30a–12:15p',
  );
  assert.equal(
    compactItemTime(meeting('late', '2026-10-05T23:30:00Z', '2026-10-06T00:15:00Z'), 'UTC'),
    '11:30p–12:15a',
  );
  assert.equal(
    compactItemTime(meeting('local', '2026-10-05T03:30:00Z', '2026-10-05T04:30:00Z'), 'Asia/Kolkata'),
    '9–10a',
  );
  assert.equal(
    compactItemTime(meeting('narrow', '2026-10-05T11:30:00Z', '2026-10-05T12:15:00Z'), 'UTC', true),
    '11:30a',
  );
  assert.equal(
    compactItemTime({ ...meeting('run', '', ''), time: { kind: 'point', at: '2026-10-05T09:00:00Z' } }, 'UTC'),
    '9a',
  );
  assert.equal(
    compactItemTime(
      { ...meeting('all-day', '', ''), time: { kind: 'all-day', start: '2026-10-05', end: '2026-10-06' } },
      'UTC',
    ),
    'All day',
  );
});
test('paired hour labels represent the same instant across zones and DST dates', () => {
  assert.deepEqual(calendarHourLabels('2026-10-05', 'Asia/Kolkata', 'UTC')[9], {
    primary: '9 AM',
    secondary: '3:30 AM',
  });
  assert.deepEqual(calendarHourLabels('2026-10-05', 'Asia/Kolkata', 'UTC')[0], {
    primary: '12 AM',
    secondary: '6:30 PM',
  });
  assert.equal(calendarHourLabels('2026-03-07', 'America/New_York', 'UTC')[9]?.secondary, '2:00 PM');
  assert.equal(calendarHourLabels('2026-03-08', 'America/New_York', 'UTC')[9]?.secondary, '1:00 PM');
  assert.equal(calendarHourLabels('2026-11-01', 'America/New_York', 'UTC')[9]?.secondary, '2:00 PM');
  assert.equal(
    calendarHourLabels('2026-10-05', 'UTC', 'UTC').every(hour => hour.secondary === null),
    true,
  );
  assert.equal(calendarHourLabels('2026-10-05', 'UTC', null).length, 24);
});
test('free time ignores automation and free events, but includes hidden busy calendars', () => {
  const items = [
    meeting('hidden', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z'),
    meeting('free', '2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z', false),
  ];
  items.push({
    ...meeting('agent', '', '', false),
    kind: 'agent',
    time: { kind: 'point', at: '2026-10-05T10:00:00Z' },
  });
  const slots = freeSlots(items, '2026-10-05', 'UTC', 60, Date.parse('2026-10-05T08:00:00Z'));
  assert.equal(slots[0]?.start, '2026-10-05T10:00:00.000+00:00');
  assert.equal(slots.at(-1)?.end, '2026-10-05T18:00:00.000Z');
  assert.equal(
    freeSlots(
      [{ ...items[0]!, time: { kind: 'all-day', start: '2026-10-05', end: '2026-10-06' } }],
      '2026-10-05',
      'UTC',
      30,
      0,
    ).length,
    0,
  );
});
