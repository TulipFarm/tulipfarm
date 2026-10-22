import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  changedValues,
  compatibleRowValues,
  rowFieldsChanged,
  validateRowDraft,
} from '../src/features/tables/record-validation.ts';
import type { TableDefinition, TableField, TableValue } from '../src/features/tables/review-contracts.ts';
import {
  workspaceMembersDefinition,
  workspaceMemberFields,
  manualWorkspaceMemberValues,
} from '@tulipfarm/tables/workspace-members';

const id = randomUUID(),
  option = randomUUID(),
  retired = randomUUID(),
  target = randomUUID();
const base = { id, label: 'Amount', required: false };
const definition = (field: TableField): TableDefinition => ({
  formatVersion: 2,
  id: randomUUID(),
  label: 'Orders',
  owningTeamId: randomUUID(),
  fields: [field],
  uniqueKeys: [],
});
const numeric: TableField = { ...base, kind: 'numeric', precision: 5, scale: 2 };
const select: TableField = {
  ...base,
  kind: 'single-select',
  options: [
    { id: option, label: 'Open', retired: false },
    { id: retired, label: 'Old', retired: true },
  ],
};
const relationship: TableField = {
  ...base,
  kind: 'relationship',
  targetTableId: target,
  cardinality: 'one',
  inverseCardinality: 'many',
  reverse: null,
  onDelete: 'restrict',
};
const valid = (field: TableField, value: TableValue) =>
  assert.deepEqual(validateRowDraft(definition(field), { [id]: value }), {});
const invalid = (field: TableField, value: TableValue) =>
  assert.ok(validateRowDraft(definition(field), { [id]: value })[id]);

test('manual member drafts require a name and valid contact email but retain unchanged account profiles', () => {
  const members = workspaceMembersDefinition(randomUUID(), randomUUID());
  const values = manualWorkspaceMemberValues({ name: 'No account needed', contactEmail: 'person@example.test' });
  assert.deepEqual(validateRowDraft(members, values, undefined, 'workspace-members'), {});
  assert.ok(
    validateRowDraft(
      members,
      { ...values, [workspaceMemberFields.name]: { kind: 'text', value: ' ' } },
      undefined,
      'workspace-members',
    )[workspaceMemberFields.name],
  );
  assert.ok(
    validateRowDraft(
      members,
      { ...values, [workspaceMemberFields.contactEmail]: { kind: 'text', value: 'not-an-email' } },
      undefined,
      'workspace-members',
    )[workspaceMemberFields.contactEmail],
  );
  const account = { ...values, [workspaceMemberFields.name]: { kind: 'text', value: '' } } satisfies Record<
    string,
    TableValue
  >;
  assert.deepEqual(
    validateRowDraft(
      members,
      { ...account, [workspaceMemberFields.active]: { kind: 'boolean', value: false } },
      account,
      'workspace-members',
    ),
    {},
  );
});

test('decimal input preserves exact strings and enforces schema precision and scale', () => {
  for (const value of ['0', '-0.01', '999.99', '-999.99']) valid(numeric, { kind: 'numeric', value });
  for (const value of ['NaN', '1e2', '01', '+1', '1,000', '1000', '0.001', '-', '1.'])
    invalid(numeric, { kind: 'numeric', value });
  valid({ ...numeric, precision: 30, scale: 10 }, { kind: 'numeric', value: '99999999999999999999.1234567890' });
  valid({ ...numeric, precision: 2, scale: 2 }, { kind: 'numeric', value: '0.99' });
  invalid({ ...numeric, precision: 2, scale: 2 }, { kind: 'numeric', value: '1.00' });
});

test('all field kinds validate against the shared server contract', () => {
  valid({ ...base, kind: 'text', maxLength: 4 }, { kind: 'text', value: 'text' });
  invalid({ ...base, kind: 'text', maxLength: 4 }, { kind: 'text', value: 'longer' });
  invalid({ ...base, kind: 'text', maxLength: 4 }, { kind: 'text', value: '\u0000' });
  valid({ ...base, kind: 'boolean', required: true }, { kind: 'boolean', value: false });
  valid({ ...base, kind: 'date' }, { kind: 'date', value: '2024-02-29' });
  invalid({ ...base, kind: 'date' }, { kind: 'date', value: '2025-02-29' });
  invalid({ ...base, kind: 'date' }, { kind: 'date', value: '0000-01-01' });
  valid({ ...base, kind: 'timestamp', timezone: 'UTC' }, { kind: 'timestamp', value: '2026-10-11T10:20:30.123+05:30' });
  invalid({ ...base, kind: 'timestamp', timezone: 'UTC' }, { kind: 'timestamp', value: 'not a date' });
  valid(select, { kind: 'single-select', optionId: option });
  invalid(select, { kind: 'single-select', optionId: retired });
  invalid(select, { kind: 'single-select', optionId: randomUUID() });
  valid({ ...select, kind: 'multi-select' }, { kind: 'multi-select', optionIds: [option] });
  invalid({ ...select, kind: 'multi-select' }, { kind: 'multi-select', optionIds: [option, option] });
  valid(relationship, { kind: 'relationship', tableId: target, recordIds: [randomUUID()] });
  invalid(relationship, { kind: 'relationship', tableId: randomUUID(), recordIds: [randomUUID()] });
  invalid(relationship, { kind: 'relationship', tableId: target, recordIds: [randomUUID(), randomUUID()] });
  valid(
    { ...relationship, cardinality: 'many' },
    { kind: 'relationship', tableId: target, recordIds: [randomUUID(), randomUUID()] },
  );
  valid(
    { ...base, kind: 'file', cardinality: 'one', access: 'independent' },
    { kind: 'file', fileIds: [randomUUID()] },
  );
  invalid(
    { ...base, kind: 'file', cardinality: 'one', access: 'independent' },
    { kind: 'file', fileIds: [randomUUID(), randomUUID()] },
  );
});

test('required nulls and empty collections fail, while false and zero remain values', () => {
  invalid({ ...numeric, required: true }, null);
  valid({ ...numeric, required: true }, { kind: 'numeric', value: '0' });
  invalid({ ...select, kind: 'multi-select', required: true }, { kind: 'multi-select', optionIds: [] });
  invalid(
    { ...relationship, required: true, cardinality: 'many' },
    { kind: 'relationship', tableId: target, recordIds: [] },
  );
  invalid(
    { ...base, kind: 'file', cardinality: 'many', required: true, access: 'independent' },
    { kind: 'file', fileIds: [] },
  );
  valid(numeric, null);
});

test('updates omit unchanged historical values and validate only the patch', () => {
  const fields: TableDefinition = { ...definition(select), fields: [select, { ...numeric, id: target }] };
  const initial = { [id]: { kind: 'single-select', optionId: retired } } satisfies Record<string, TableValue>;
  const values = { ...initial, [target]: { kind: 'numeric', value: '12.34' } } satisfies Record<string, TableValue>;
  assert.deepEqual(validateRowDraft(fields, values, initial), {});
  assert.deepEqual(changedValues(values, initial), { [target]: { kind: 'numeric', value: '12.34' } });
  assert.deepEqual(changedValues({ [id]: null }, {}), {});
  assert.deepEqual(changedValues({ [id]: null }, initial), { [id]: null });
  assert.ok(validateRowDraft(fields, initial, { [id]: { kind: 'single-select', optionId: option } })[id]);
});

test('draft schema review ignores labels but detects changed fields and constraints', () => {
  const before = definition(numeric);
  const renamed = { ...before, label: 'Renamed table', fields: [{ ...numeric, label: 'Price' }] };
  assert.equal(rowFieldsChanged(before, renamed), false);
  assert.equal(rowFieldsChanged(before, { ...before, fields: [{ ...numeric, required: true }] }), true);
  assert.equal(rowFieldsChanged(before, { ...before, fields: [{ ...numeric, precision: 4 }] }), true);
  assert.equal(rowFieldsChanged(before, { ...before, fields: [] }), true);
  assert.equal(
    rowFieldsChanged(
      definition(select),
      definition({ ...select, options: select.options.map(item => ({ ...item, retired: true })) }),
    ),
    true,
  );
});

test('schema review keeps exact compatible values and identifies incompatible input without mutating it', () => {
  const values = {
    [id]: { kind: 'numeric', value: '123.45' },
    [target]: { kind: 'text', value: 'Keep until reviewed' },
  } satisfies Record<string, TableValue>;
  const original = structuredClone(values);
  const smaller = definition({ ...numeric, precision: 3 });
  assert.deepEqual(
    compatibleRowValues(smaller, values),
    { [id]: values[id] },
    'Changed limits do not truncate or coerce typed values',
  );
  assert.ok(
    validateRowDraft(smaller, compatibleRowValues(smaller, values))[id],
    'Retained input still needs current validation',
  );
  assert.deepEqual(
    compatibleRowValues(definition({ ...base, kind: 'boolean' }), values),
    {},
    'A changed kind is not silently coerced',
  );
  assert.deepEqual(values, original, 'Review preparation never discards input');
  assert.deepEqual(compatibleRowValues(definition({ ...base, kind: 'boolean' }), { [id]: null }), { [id]: null });
});

test('schema review never rebinds a link or truncates multi-value input', () => {
  const links = {
    [id]: { kind: 'relationship', tableId: target, recordIds: [randomUUID(), randomUUID()] },
  } satisfies Record<string, TableValue>;
  assert.deepEqual(compatibleRowValues(definition(relationship), links), {});
  assert.deepEqual(compatibleRowValues(definition({ ...relationship, cardinality: 'many' }), links), links);
  assert.deepEqual(
    compatibleRowValues(definition({ ...relationship, cardinality: 'many', targetTableId: randomUUID() }), links),
    {},
  );
  const files = { [id]: { kind: 'file', fileIds: [randomUUID(), randomUUID()] } } satisfies Record<string, TableValue>;
  assert.deepEqual(
    compatibleRowValues(definition({ ...base, kind: 'file', cardinality: 'one', access: 'independent' }), files),
    {},
  );
  assert.deepEqual(
    compatibleRowValues(definition({ ...base, kind: 'file', cardinality: 'many', access: 'independent' }), files),
    files,
  );
});
