import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNote, stepNote } from '../src/features/workflows/run-notes.ts';

const input = {
  tableId: '7c0b8c7e-4f0e-4e3b-9a52-0d3f1f2b6a11',
  recordId: '1d6f0f5a-2b9e-4c41-8f7a-5e0c4b1a9d22',
  scheduledFor: '2026-10-08T09:00:00.000Z',
};

test('a record run skipped for oversized values explains why it did not run', () => {
  assert.match(
    runNote({ source: 'record', status: 'skipped', error: 'record-values-too-large', input }) ?? '',
    /^Skipped the run scheduled for .+ because the record's values are larger than a workflow run can receive\.$/,
  );
});

test('other record runs carry no note', () => {
  assert.equal(runNote({ source: 'record', status: 'queued', error: null, input: { ...input, values: {} } }), null);
});

test('record runs missed after a long hold-up explain that they were too late to run', () => {
  const missed = {
    tableId: input.tableId,
    scheduledFor: '2026-10-02T09:00:00.000Z',
    missedThrough: '2026-10-07T09:00:00.000Z',
    missedCount: 1200,
  };
  assert.match(
    runNote({ source: 'record', status: 'skipped', error: 'missed-occurrences-coalesced', input: missed }) ?? '',
    /^Missed 1\D?200 record runs scheduled from .+ through .+\. They were more than a day late, so they did not run\.$/,
  );
  assert.match(
    runNote({
      source: 'record',
      status: 'skipped',
      error: 'missed-occurrences-coalesced',
      input: { ...missed, missedThrough: missed.scheduledFor, missedCount: 40 },
    }) ?? '',
    /^Missed 40 record runs scheduled for [^.]+\. They were/,
    'records sharing one due time name it once',
  );
  assert.match(
    runNote({
      source: 'record',
      status: 'skipped',
      error: 'missed-occurrences-coalesced',
      input: { ...missed, missedThrough: missed.scheduledFor, missedCount: 1 },
    }) ?? '',
    /^Missed the record run scheduled for .+\. It was more than a day late, so it did not run\.$/,
  );
});

test('row changes skipped past the queue name how many and when they happened', () => {
  const coalesced = {
    event: 'updated',
    tableId: input.tableId,
    firstChangedAt: '2026-10-08T09:00:00.000Z',
    lastChangedAt: '2026-10-08T09:05:00.000Z',
    coalescedCount: 30,
  };
  assert.match(
    runNote({ source: 'row', status: 'skipped', error: 'row-changes-coalesced', input: coalesced }) ?? '',
    /^Skipped 30 row changes from .+ through .+ because more changes arrived than the workflow can queue\.$/,
  );
  assert.match(
    runNote({
      source: 'row',
      status: 'skipped',
      error: 'row-changes-coalesced',
      input: { ...coalesced, lastChangedAt: coalesced.firstChangedAt, coalescedCount: 1200 },
    }) ?? '',
    /^Skipped 1\D?200 row changes at [^.]+ because more/,
    'changes sharing one time name it once',
  );
});

test('a row run skipped for oversized values names the row and its change', () => {
  const change = {
    event: 'updated',
    tableId: input.tableId,
    recordId: input.recordId,
    token: '5b8c1f2e-9d3a-4e7b-8c6f-1a2b3c4d5e6f',
    changedAt: '2026-10-08T09:00:00.000Z',
    changedFieldIds: [],
  };
  assert.match(
    runNote({ source: 'row', status: 'skipped', error: 'record-values-too-large', input: change }) ?? '',
    /^Skipped the run for row 1d6f0f5a, updated at .+, because the row's values are larger than a workflow run can receive\.$/,
  );
  assert.match(
    runNote({
      source: 'row',
      status: 'skipped',
      error: 'record-values-too-large',
      input: { ...change, event: 'deleted', token: undefined },
    }) ?? '',
    /^Skipped the run for row 1d6f0f5a, deleted at /,
  );
});

test('row runs that started carry no note', () => {
  assert.equal(
    runNote({
      source: 'row',
      status: 'queued',
      error: null,
      input: {
        event: 'created',
        tableId: input.tableId,
        recordId: input.recordId,
        changedAt: '2026-10-08T09:00:00.000Z',
        values: {},
      },
    }),
    null,
  );
});

test('table steps name the rows they changed or found', () => {
  const token = '5b8c1f2e-9d3a-4e7b-8c6f-1a2b3c4d5e6f';
  assert.equal(
    stepNote({ operation: 'created', tableId: input.tableId, recordId: input.recordId, token, fieldIds: ['a', 'b'] }),
    'Created row 1d6f0f5a, writing 2 fields.',
  );
  assert.equal(
    stepNote({ operation: 'updated', tableId: input.tableId, recordId: input.recordId, token, fieldIds: ['a'] }),
    'Updated row 1d6f0f5a, writing 1 field.',
  );
  assert.equal(
    stepNote({ withheld: 'source-access' }),
    'This step’s output is hidden because it uses information you cannot access.',
  );
  assert.equal(
    stepNote({ tableId: input.tableId, rows: [{ recordId: input.recordId, token, values: {} }], more: true }),
    'Found 1 row and left out further matches: 1d6f0f5a.',
  );
  assert.equal(stepNote({ tableId: input.tableId, rows: [], more: false }), 'Found no matching rows.');
  assert.equal(stepNote({ decision: 'approved' }), null);
});

test('condition steps say whether the condition held and which steps ran or were skipped', () => {
  assert.equal(
    stepNote({ matched: true, ran: ['send_notice'], skipped: ['hold_order'] }),
    'Condition met, so it ran send notice and skipped hold order.',
  );
  assert.equal(
    stepNote({ matched: false, ran: [], skipped: ['send_notice'] }),
    'Condition not met, so it skipped send notice.',
  );
  assert.equal(
    stepNote({ matched: false, ran: ['hold_order'], skipped: [] }),
    'Condition not met, so it ran hold order.',
  );
  assert.equal(
    stepNote({ matched: true, ran: ['send_notice', 'tag_row', 'email'], skipped: ['hold_order'] }),
    'Condition met, so it ran send notice, tag row and email, and skipped hold order.',
  );
});
