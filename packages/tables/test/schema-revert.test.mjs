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
  builder.add(randomUUID(), { [field.id]: text('Plan') });
  const revert = builder.finish('r1');
  assert.deepEqual(revert.plan.target, table([field]));
  assert.equal(revert.plan.expectedRevision, 'r1');
  assert.deepEqual(revert.plan.transforms.outputs, []);
  assert.deepEqual(revert.fields, []);
});

test('a kind change converts back and restores each unchanged row its own retained value', () => {
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
    [randomUUID(), { [due.id]: timestamp(same) }, { [due.id]: text('2024-01-02T09:30:00+05:30') }],
    // Written since the change: keeps its current value, converted back to text.
    [randomUUID(), { [due.id]: timestamp('2025-05-05T05:05:05.000Z') }, undefined],
    // Two rows share a current value but had different earlier text; each gets its own back.
    [randomUUID(), { [due.id]: timestamp('2024-03-01T00:00:00.000Z') }, { [due.id]: text('2024-03-01T00:00:00Z') }],
    [
      randomUUID(),
      { [due.id]: timestamp('2024-03-01T00:00:00.000Z') },
      { [due.id]: text('2024-03-01T01:00:00+01:00') },
    ],
  ];
  for (const [id, values, retained] of rows) builder.add(id, values, retained);
  const revert = builder.finish('r2');
  assert.deepEqual(revert.fields, [{ fieldId: due.id, label: 'Due', restored: 3, kept: 1 }]);
  assert.deepEqual(revert.removed, [{ fieldId: added.id, label: 'Owner' }]);
  const outputs = rows.map(
    ([recordId, values]) =>
      evaluateTransforms({ transforms: revert.plan.transforms, values, target: revert.plan.target, recordId }).values[
        due.id
      ],
  );
  assert.deepEqual(outputs, [
    text('2024-01-02T09:30:00+05:30'),
    text('2025-05-05T05:05:05.000Z'),
    text('2024-03-01T00:00:00Z'),
    text('2024-03-01T01:00:00+01:00'),
  ]);
});

test('reverting a numeric conversion brings back texts it cleared and the original decimal spelling', () => {
  const amount = { id: randomUUID(), label: 'Amount', kind: 'text', required: false, maxLength: 1000 };
  const builder = schemaRevertBuilder({
    before: table([amount]),
    after: table([{ id: amount.id, label: 'Amount', kind: 'numeric', required: false, precision: 12, scale: 3 }]),
    recomputed: [amount.id],
  });
  const numeric = value => ({ kind: 'numeric', value });
  const rows = [
    [randomUUID(), { [amount.id]: null }, { [amount.id]: text('1e3') }],
    [randomUUID(), { [amount.id]: null }, { [amount.id]: text('abc') }],
    [randomUUID(), { [amount.id]: numeric('100.500') }, { [amount.id]: text('100.50') }],
    [randomUUID(), { [amount.id]: numeric('5.000') }, { [amount.id]: text('5') }],
  ];
  for (const [id, values, retained] of rows) builder.add(id, values, retained);
  const revert = builder.finish('r4');
  assert.deepEqual(revert.fields, [{ fieldId: amount.id, label: 'Amount', restored: 4, kept: 0 }]);
  assert.deepEqual(
    rows.map(
      ([recordId, values]) =>
        evaluateTransforms({ transforms: revert.plan.transforms, values, target: revert.plan.target, recordId }).values[
          amount.id
        ],
    ),
    [text('1e3'), text('abc'), text('100.50'), text('5')],
  );
});

test('a removed field returns with its identity', () => {
  const kept = { id: randomUUID(), label: 'Title', kind: 'text', required: false, maxLength: 1000 };
  const removed = { id: randomUUID(), label: 'Notes', kind: 'text', required: false, maxLength: 1000 };
  const builder = schemaRevertBuilder({ before: table([kept, removed]), after: table([kept]), recomputed: [] });
  const revert = builder.finish('r3');
  assert.deepEqual(revert.plan.target.fields[1], removed);
  assert.deepEqual(revert.returned, [{ fieldId: removed.id, label: 'Notes' }]);
});
