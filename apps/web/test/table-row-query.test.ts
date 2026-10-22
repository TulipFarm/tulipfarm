import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localDateTime, rowTotal, utcTimestamp } from '../src/features/tables/row-query.ts';

test('row totals read as counts and timestamp picker values round-trip through local time to UTC', () => {
  assert.equal(rowTotal('1', false), '1 row');
  assert.equal(rowTotal('42', false), '42 rows');
  assert.equal(rowTotal('10000+', false), '10,000+ rows');
  assert.equal(rowTotal('42', true), '42 matching rows');
  assert.equal(rowTotal('1', true), '1 matching row');
  const local = localDateTime('2026-10-02T12:30:00Z');
  assert.equal(utcTimestamp(local), '2026-10-02T12:30:00Z');
  assert.equal(localDateTime(utcTimestamp(local)), local);
  assert.equal(localDateTime('not a time'), '');
  assert.equal(utcTimestamp(''), '');
});
