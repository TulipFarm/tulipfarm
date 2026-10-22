import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarOccurrences, missedOccurrences, nextCronOccurrences, nextOccurrence } from '../src/schedule.ts';
import { triggerSchema } from '../src/contracts.ts';

test('cron uses IANA timezones and skips missed occurrences instead of replaying a backlog', () => {
  assert.equal(
    nextOccurrence(
      { kind: 'cron', expression: '30 9 * * 1-5', timezone: 'America/New_York' },
      new Date('2026-09-28T12:00:00Z'),
    ),
    '2026-09-28T13:30:00.000Z',
  );
  assert.equal(
    nextOccurrence(
      { kind: 'cron', expression: '30 9 * * 1-5', timezone: 'America/New_York' },
      new Date('2026-11-02T12:00:00Z'),
    ),
    '2026-11-02T14:30:00.000Z',
  );
  assert.equal(
    nextOccurrence({ kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' }, new Date('2026-09-28T12:17:20Z')),
    '2026-09-28T12:20:00.000Z',
  );
  assert.throws(() => nextOccurrence({ kind: 'cron', expression: '0 25 * * *', timezone: 'UTC' }, new Date()));
  assert.throws(() => nextOccurrence({ kind: 'cron', expression: '0 9 * * *', timezone: 'Not/AZone' }, new Date()));
});

test('calendar expansion preserves interval phase, half-open boundaries and explicit truncation', () => {
  const trigger = { kind: 'interval', minutes: 60 };
  assert.deepEqual(
    calendarOccurrences(trigger, '2026-10-05T09:15:00Z', '2026-10-05T10:00:00Z', '2026-10-05T12:15:00Z'),
    { times: ['2026-10-05T10:15:00.000Z', '2026-10-05T11:15:00.000Z'], more: false },
  );
  assert.deepEqual(
    calendarOccurrences(trigger, '2026-10-05T09:15:00Z', '2026-10-05T09:15:00Z', '2026-10-05T12:15:00Z', 2),
    { times: ['2026-10-05T09:15:00.000Z', '2026-10-05T10:15:00.000Z'], more: true },
  );
  assert.deepEqual(
    calendarOccurrences(
      { kind: 'once', at: '2026-10-05T09:00:00Z' },
      '2026-10-05T09:00:00Z',
      '2026-10-05T09:00:00Z',
      '2026-10-06T00:00:00Z',
    ).times,
    ['2026-10-05T09:00:00.000Z'],
  );
  assert.deepEqual(
    calendarOccurrences({ kind: 'manual' }, '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z', '2026-10-06T00:00:00Z'),
    { times: [], more: false },
  );
  assert.throws(() => calendarOccurrences(trigger, 'invalid', '2026-10-05T09:00:00Z', '2026-10-06T00:00:00Z'));
});

test('calendar daily cron follows local time across daylight saving', () => {
  assert.deepEqual(
    calendarOccurrences(
      { kind: 'cron', expression: '0 9 * * *', timezone: 'America/New_York' },
      '2026-10-31T13:00:00Z',
      '2026-10-31T00:00:00Z',
      '2026-11-03T00:00:00Z',
    ),
    {
      times: ['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z'],
      more: false,
    },
  );
});

test('cron returns its next three occurrences in its IANA time zone', () => {
  assert.deepEqual(
    nextCronOccurrences({ kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' }, new Date('2026-09-28T12:17:20Z')),
    ['2026-09-28T12:20:00.000Z', '2026-09-28T12:25:00.000Z', '2026-09-28T12:30:00.000Z'],
  );
});

test('once returns its instant as a normalized UTC string regardless of the current time', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  assert.equal(nextOccurrence({ kind: 'once', at: '2026-10-05T09:30:00Z' }, now), '2026-10-05T09:30:00.000Z');
  assert.equal(nextOccurrence({ kind: 'once', at: '2026-10-05T09:30:00.5Z' }, now), '2026-10-05T09:30:00.500Z');
  assert.equal(nextOccurrence({ kind: 'once', at: '2026-10-01T00:00:00Z' }, now), '2026-10-01T00:00:00.000Z');
  assert.equal(
    nextOccurrence({ kind: 'once', at: '2026-10-05T09:30:00Z' }, new Date('2030-01-01T00:00:00Z')),
    '2026-10-05T09:30:00.000Z',
  );
});

test('interval occurrences preserve the activation-time grid across delayed sweeps', () => {
  assert.equal(
    nextOccurrence({ kind: 'interval', minutes: 1 }, new Date('2026-09-28T12:00:00Z')),
    '2026-09-28T12:01:00.000Z',
  );
  assert.equal(
    nextOccurrence({ kind: 'interval', minutes: 90 }, new Date('2026-09-28T23:15:30.250Z')),
    '2026-09-29T00:45:30.250Z',
  );
  assert.equal(
    nextOccurrence({ kind: 'interval', minutes: 525600 }, new Date('2027-01-01T00:00:00Z')),
    '2028-01-01T00:00:00.000Z',
  );
  assert.equal(
    nextOccurrence({ kind: 'interval', minutes: 60 }, new Date('2026-11-01T05:30:00Z')),
    '2026-11-01T06:30:00.000Z',
  );
});

test('only recurring and one-time triggers have a next run', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  assert.equal(nextOccurrence({ kind: 'manual' }, now), null);
  assert.equal(nextOccurrence({ kind: 'webhook' }, now), null);
});

test('cron accepts day and month names and macros by saving their numeric form', () => {
  const cron = expression => triggerSchema.parse({ kind: 'cron', expression, timezone: 'UTC' }).expression;
  assert.equal(cron('0 9 * * MON-FRI'), '0 9 * * 1-5');
  assert.equal(cron('0 9 * * mon,Wed,FRI'), '0 9 * * 1,3,5');
  assert.equal(cron('0 9 1 JAN-MAR,dec *'), '0 9 1 1-3,12 *');
  assert.equal(cron(' @daily '), '0 0 * * *');
  assert.equal(cron('@HOURLY'), '0 * * * *');
  assert.equal(cron('@weekly'), '0 0 * * 0');
  assert.equal(cron('@monthly'), '0 0 1 * *');
  assert.equal(cron('@yearly'), '0 0 1 1 *');
  assert.equal(cron('@midnight'), '0 0 * * *');
  assert.equal(cron('30  9 * *   1-5'), '30 9 * * 1-5');
  assert.equal(cron('0 9 l * 5l'), '0 9 L * 5L');
  for (const invalid of [
    '@reboot',
    '0 9 * * FUNDAY',
    '0 9 * * SUNSAT',
    'MON 9 * * *',
    '0 L * * *',
    '? 9 * * *',
    '0 9 * L *',
    '0 9 1#2 * *',
    '0 9 * *',
    '0 9 * * 1 2026',
    '0 9 15W * *',
  ])
    assert.equal(
      triggerSchema.safeParse({ kind: 'cron', expression: invalid, timezone: 'UTC' }).success,
      false,
      invalid,
    );
});

test('cron schedules the last day, last weekday and nth weekday of a month', () => {
  const next = expression =>
    nextOccurrence(
      triggerSchema.parse({ kind: 'cron', expression, timezone: 'UTC' }),
      new Date('2026-10-08T12:00:00Z'),
    );
  assert.equal(next('0 9 L * *'), '2026-10-31T09:00:00.000Z');
  assert.equal(next('0 9 * * 5L'), '2026-10-30T09:00:00.000Z');
  assert.equal(next('0 9 * * MON#2'), '2026-10-12T09:00:00.000Z');
  assert.equal(next('0 9 ? * 1'), '2026-10-12T09:00:00.000Z');
  assert.equal(next('0 9 * * MON-FRI'), '2026-10-09T09:00:00.000Z');
});

test('a one-time trigger keeps its chosen time zone for display and rejects unknown zones', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const once = triggerSchema.parse({ kind: 'once', at: '2026-10-05T07:30:00Z', timezone: 'Europe/London' });
  assert.deepEqual(once, { kind: 'once', at: '2026-10-05T07:30:00Z', timezone: 'Europe/London' });
  assert.equal(nextOccurrence(once, now), '2026-10-05T07:30:00.000Z');
  assert.throws(() => nextOccurrence({ kind: 'once', at: '2026-10-05T07:30:00Z', timezone: 'Not/AZone' }, now));
  assert.equal(triggerSchema.safeParse({ kind: 'once', at: '2026-10-05T07:30:00Z', timezone: '' }).success, false);
});

test('missed occurrences name the first and last skipped time between the late due time and the sweep', () => {
  assert.deepEqual(
    missedOccurrences(
      { kind: 'interval', minutes: 60 },
      new Date('2026-10-08T09:00:00Z'),
      new Date('2026-10-08T11:30:00Z'),
    ),
    { scheduledFor: '2026-10-08T10:00:00.000Z', missedThrough: '2026-10-08T11:00:00.000Z', missedCount: 2 },
  );
  assert.deepEqual(
    missedOccurrences(
      { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York' },
      new Date('2026-10-02T13:00:00Z'),
      new Date('2026-10-07T12:00:00Z'),
    ),
    { scheduledFor: '2026-10-05T13:00:00.000Z', missedThrough: '2026-10-06T13:00:00.000Z', missedCount: 2 },
  );
  assert.equal(
    missedOccurrences(
      { kind: 'interval', minutes: 60 },
      new Date('2026-10-08T09:00:00Z'),
      new Date('2026-10-08T09:59:59Z'),
    ),
    null,
  );
  assert.equal(
    missedOccurrences(
      { kind: 'once', at: '2026-10-08T09:00:00Z' },
      new Date('2026-10-08T09:00:00Z'),
      new Date('2026-10-09T09:00:00Z'),
    ),
    null,
  );
  assert.deepEqual(
    missedOccurrences(
      { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-12-31T00:00:30Z'),
    ),
    {
      scheduledFor: '2026-01-01T00:01:00.000Z',
      missedThrough: '2026-12-31T00:00:00.000Z',
      missedCount: 1000,
      missedCountCapped: true,
    },
  );
  assert.deepEqual(
    missedOccurrences(
      { kind: 'interval', minutes: 1 },
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-12-31T00:00:30Z'),
    ),
    { scheduledFor: '2026-01-01T00:01:00.000Z', missedThrough: '2026-12-31T00:00:00.000Z', missedCount: 524160 },
  );
  assert.deepEqual(
    missedOccurrences(
      { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      new Date('2026-10-07T09:00:00Z'),
      new Date('2026-10-08T09:00:00Z'),
    ),
    { scheduledFor: '2026-10-08T09:00:00.000Z', missedThrough: '2026-10-08T09:00:00.000Z', missedCount: 1 },
  );
});
