import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { importEffects } from '../dist/proposal-data.js';
import { TableImportPlanError } from '../dist/proposal-contracts.js';

const id = () => randomUUID();
const open = id(),
  done = id(),
  retired = id(),
  red = id(),
  blue = id();
const fields = {
  name: { id: id(), label: 'Name', kind: 'text', required: true, maxLength: 20 },
  status: {
    id: id(),
    label: 'Status',
    kind: 'single-select',
    required: false,
    options: [
      { id: open, label: 'Open', retired: false },
      { id: done, label: 'Done', retired: false },
      { id: retired, label: 'Old', retired: true },
    ],
  },
  tags: {
    id: id(),
    label: 'Tags',
    kind: 'multi-select',
    required: false,
    options: [
      { id: red, label: 'Red', retired: false },
      { id: blue, label: 'Blue', retired: false },
    ],
  },
  amount: { id: id(), label: 'Amount', kind: 'numeric', required: false, precision: 8, scale: 2 },
  due: { id: id(), label: 'Due', kind: 'date', required: false },
  paid: { id: id(), label: 'Paid', kind: 'boolean', required: false },
};
const definition = {
  formatVersion: 2,
  id: id(),
  owningTeamId: id(),
  label: 'Orders',
  fields: Object.values(fields),
  uniqueKeys: [{ id: id(), fieldIds: [fields.name.id], nulls: 'distinct' }],
};
const columns = { Name: 'name', Status: 'status', Tags: 'tags', Amount: 'amount', Due: 'due', Paid: 'paid' };
const plan = (mappings = columns, matchFieldIds = [fields.name.id]) => ({
  kind: 'import',
  tableId: definition.id,
  expectedRevision: 'r',
  dependsOn: [],
  reference: { kind: 'file', attachmentId: id(), contentDigest: 'a'.repeat(64) },
  matchFieldIds,
  mappings: Object.entries(mappings).map(([sourceColumn, field]) => ({ sourceColumn, fieldId: fields[field].id })),
});
const text = value => (value === null ? null : { kind: 'text', value });
const row = values => Object.fromEntries(Object.keys(columns).map(name => [name, text(values[name] ?? null)]));
const run = (rows, input = plan(), records = []) => importEffects(input, definition, records, rows, () => id());
const problems = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof TableImportPlanError, String(error));
    assert.equal(error.code, 'invalid-import');
    return error;
  }
  assert.fail('expected the import plan to be rejected');
};

test('file text converts to each destination kind, matching select options by label', () => {
  const [effect] = run([
    row({ Name: 'A-1', Status: ' open ', Tags: 'red, Blue', Amount: '12.50', Due: '2026-01-31', Paid: 'TRUE' }),
  ]);
  assert.deepEqual(effect.after, {
    [fields.name.id]: { kind: 'text', value: 'A-1' },
    [fields.status.id]: { kind: 'single-select', optionId: open },
    [fields.tags.id]: { kind: 'multi-select', optionIds: [red, blue] },
    [fields.amount.id]: { kind: 'numeric', value: '12.50' },
    [fields.due.id]: { kind: 'date', value: '2026-01-31' },
    [fields.paid.id]: { kind: 'boolean', value: true },
  });
  const [blank] = run([row({ Name: 'A-2', Status: '', Amount: ' ' })]);
  assert.equal(blank.after[fields.status.id], null);
  assert.equal(blank.after[fields.amount.id], null);
});

test('values that cannot convert name their row, column, field, value and valid choices', () => {
  const error = problems(() =>
    run([
      row({ Name: 'A-1', Status: 'Open' }),
      row({ Name: 'A-2', Status: 'Pending', Amount: '1,200' }),
      row({ Name: 'A-3', Status: 'Old', Due: '31/01/2026' }),
      row({ Name: null }),
      row({ Name: 'A-1' }),
    ]),
  );
  assert.equal(error.total, 6);
  assert.deepEqual(
    error.problems.map(({ row, column, field, code, value }) => [row, column, field, code, value]),
    [
      [2, 'Status', 'Status', 'unmapped-value', 'Pending'],
      [2, 'Amount', 'Amount', 'conversion-failed', '1,200'],
      [3, 'Status', 'Status', 'unmapped-value', 'Old'],
      [3, 'Due', 'Due', 'conversion-failed', '31/01/2026'],
      [4, 'Name', 'Name', 'missing-field', null],
      [5, 'Name', 'Name', 'duplicate-key', 'A-1'],
    ],
  );
  assert.deepEqual(error.problems[0].expected, ['Open', 'Done']);
});

test('mapping mistakes are named before any row is read', () => {
  const unknown = problems(() => run([row({ Name: 'A-1' })], plan({ Name: 'name', State: 'status' })));
  assert.deepEqual(
    unknown.problems.map(({ column, code, expected }) => [column, code, expected]),
    [['State', 'unknown-column', Object.keys(columns)]],
  );
  const key = problems(() => run([row({ Name: 'A-1' })], plan(columns, [fields.status.id])));
  assert.deepEqual(
    key.problems.map(({ code, field, expected }) => [code, field, expected]),
    [['key-not-unique', 'Status', ['Name']]],
  );
  const unmapped = problems(() => run([row({ Name: 'A-1' })], plan({ Status: 'status' })));
  assert.deepEqual(
    unmapped.problems.map(({ code, field }) => [code, field]),
    [['key-unmapped', 'Name']],
  );
});
