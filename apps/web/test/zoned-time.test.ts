import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromZonedInput, zonedInput } from '../src/features/workflows/zoned-time.ts';

const iso = (value: string, zone: string) => new Date(fromZonedInput(value, zone)).toISOString();

test('a one-time picker value is read as wall-clock time in the chosen zone', () => {
  assert.equal(iso('2099-03-04T05:06', 'Asia/Tokyo'), '2099-03-03T20:06:00.000Z');
  assert.equal(iso('2026-07-01T09:00', 'America/New_York'), '2026-07-01T13:00:00.000Z');
  assert.equal(iso('2026-12-31T23:30', 'Asia/Kolkata'), '2026-12-31T18:00:00.000Z');
  assert.equal(iso('2026-01-01T00:00', 'UTC'), '2026-01-01T00:00:00.000Z');
  assert.equal(zonedInput(Date.parse('2099-03-03T20:06:00Z'), 'Asia/Tokyo'), '2099-03-04T05:06');
  assert.equal(zonedInput(Date.parse('2026-10-04T23:00:00Z'), 'Europe/London'), '2026-10-05T00:00');
  assert.ok(Number.isNaN(fromZonedInput('', 'UTC')));
  assert.ok(Number.isNaN(fromZonedInput('2026-02-30', 'UTC')));
});

test('a skipped time moves forward by the daylight-saving gap and a repeated time takes the earlier instant', () => {
  assert.equal(iso('2026-03-08T02:30', 'America/Los_Angeles'), '2026-03-08T10:30:00.000Z');
  assert.equal(iso('2026-03-29T01:30', 'Europe/London'), '2026-03-29T01:30:00.000Z');
  assert.equal(iso('2026-09-06T00:00', 'America/Santiago'), '2026-09-06T04:00:00.000Z');
  assert.equal(iso('2026-11-01T01:30', 'America/Los_Angeles'), '2026-11-01T08:30:00.000Z');
  assert.equal(iso('2026-10-25T01:30', 'Europe/London'), '2026-10-25T00:30:00.000Z');
});
