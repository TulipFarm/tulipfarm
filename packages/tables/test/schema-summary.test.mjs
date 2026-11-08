import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSchemaChange } from '@tulipfarm/tables/schema-summary';

const table = '00000000-0000-4000-8000-000000000001';
const team = '00000000-0000-4000-8000-000000000002';
const notes = '00000000-0000-4000-8000-000000000003';
const start = '00000000-0000-4000-8000-000000000004';
const status = '00000000-0000-4000-8000-000000000005';
const open = '00000000-0000-4000-8000-000000000006';
const done = '00000000-0000-4000-8000-000000000007';
const key = '00000000-0000-4000-8000-000000000008';
const other = '00000000-0000-4000-8000-000000000009';
const definition = (fields, uniqueKeys = []) => ({
  formatVersion: 2,
  id: table,
  owningTeamId: team,
  label: 'Tickets',
  fields,
  uniqueKeys,
});
const notesField = { id: notes, label: 'Notes', kind: 'text', required: false, maxLength: 1000 };
const startField = { id: start, label: 'Start', kind: 'text', required: false, maxLength: 100 };
const statusField = {
  id: status,
  label: 'Status',
  kind: 'single-select',
  required: false,
  options: [
    { id: open, label: 'Open', retired: false },
    { id: done, label: 'Done', retired: false },
  ],
};

test('names renames and kind changes by field identity, not position', () => {
  const before = definition([notesField, startField]);
  const { maxLength: _, ...startBase } = startField;
  const after = definition([
    { ...startBase, kind: 'timestamp', timezone: 'UTC' },
    { ...notesField, label: 'Remarks' },
  ]);
  assert.deepEqual(summarizeSchemaChange(before, after, [start]), [
    'Start: text to timestamp',
    'Renamed Notes to Remarks',
    'Recomputed values of Start',
  ]);
});

test('covers added and removed fields, requirement, options and unique keys', () => {
  const before = definition([notesField, statusField], [{ id: key, fieldIds: [notes], nulls: 'distinct' }]);
  const after = definition(
    [
      { ...statusField, required: true, options: [{ id: open, label: 'New', retired: false }] },
      { ...startField, id: other, label: 'Due' },
    ],
    [{ id: other, fieldIds: [status], nulls: 'distinct' }],
  );
  assert.deepEqual(summarizeSchemaChange(before, after), [
    'Status: optional to required',
    'Status: renamed option Open to New',
    'Status: removed option Done',
    'Added Due (text)',
    'Removed Notes',
    'Added unique key on Status',
    'Removed unique key on Notes',
  ]);
});

test('reports a new table and a change without field differences', () => {
  assert.deepEqual(summarizeSchemaChange(null, definition([notesField])), [
    'Created table Tickets',
    'Added Notes (text)',
  ]);
  assert.deepEqual(summarizeSchemaChange(definition([notesField]), definition([notesField])), ['No field changes']);
});
