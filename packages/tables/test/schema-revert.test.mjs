import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { schemaRevertBuilder } from '../dist/schema-revert.js';
import { evaluateTransforms } from '../dist/transforms.js';

const table = fields => ({
  formatVersion: 2,
  id: '00000000-0000-4000-8000-000000000001',
  owningTeamId: '00000000-0000-4000-8000-000000000002',
  label: 'Tasks',
  fields,
  uniqueKeys: [],
});
const text = value => ({ kind: 'text', value });
const timestamp = value => ({ kind: 'timestamp', value });

test('a rename reverts to the earlier definition without recomputing values', () => {
  const field = { id: randomUUID(), label: 'Title', kind: 'text', required: false, maxLength: 1000 };
  const builder = schemaRevertBuilder({
    before: table([field]),
    after: table([{ ...field, label: 'Name' }]),
    recomputed: [],
  });
  builder.add({ [field.id]: text('Plan') });
  const revert = builder.finish('r1');
  assert.deepEqual(revert.plan.target, table([field]));
  assert.equal(revert.plan.expectedRevision, 'r1');
  assert.deepEqual(revert.plan.transforms.outputs, []);
  assert.deepEqual(revert.fields, []);
});

test('a kind change converts back and restores retained values only where every matching row agrees', () => {
  const due = { id: randomUUID(), label: 'Due', kind: 'text', required: false, maxLength: 1000 };
  const added = { id: randomUUID(), label: 'Owner', kind: 'text', required: false, maxLength: 1000 };
  const builder = schemaRevertBuilder({
    before: table([due]),
    after: table([{ id: due.id, label: 'Due', kind: 'timestamp', required: false, timezone: 'UTC' }, added]),
    recomputed: [due.id],
  });
  const same = '2024-01-02T04:00:00.000Z';
  const rows = [
    // Unchanged since the change: its earlier text comes back.
    [{ [due.id]: timestamp(same) }, { [due.id]: text('2024-01-02T09:30:00+05:30') }],
    // Written since the change: keeps its current value, converted back to text.
    [{ [due.id]: timestamp('2025-05-05T05:05:05.000Z') }, undefined],
    // Two rows share a current value but had different earlier text, so neither can be restored.
    [{ [due.id]: timestamp('2024-03-01T00:00:00.000Z') }, { [due.id]: text('2024-03-01T00:00:00Z') }],
    [{ [due.id]: timestamp('2024-03-01T00:00:00.000Z') }, { [due.id]: text('2024-03-01T01:00:00+01:00') }],
  ];
  for (const [values, retained] of rows) builder.add(values, retained);
  const revert = builder.finish('r2');
  assert.deepEqual(revert.fields, [{ fieldId: due.id, label: 'Due', restored: 1, kept: 3 }]);
  assert.deepEqual(revert.removed, [{ fieldId: added.id, label: 'Owner' }]);
  const outputs = rows.map(
    ([values]) =>
      evaluateTransforms({ transforms: revert.plan.transforms, values, target: revert.plan.target }).values[due.id],
  );
  assert.deepEqual(outputs, [
    text('2024-01-02T09:30:00+05:30'),
    text('2025-05-05T05:05:05.000Z'),
    text('2024-03-01T00:00:00.000Z'),
    text('2024-03-01T00:00:00.000Z'),
  ]);
});

test('a removed field returns with its identity', () => {
  const kept = { id: randomUUID(), label: 'Title', kind: 'text', required: false, maxLength: 1000 };
  const removed = { id: randomUUID(), label: 'Notes', kind: 'text', required: false, maxLength: 1000 };
  const builder = schemaRevertBuilder({ before: table([kept, removed]), after: table([kept]), recomputed: [] });
  const revert = builder.finish('r3');
  assert.deepEqual(revert.plan.target.fields[1], removed);
  assert.deepEqual(revert.returned, [{ fieldId: removed.id, label: 'Notes' }]);
});
