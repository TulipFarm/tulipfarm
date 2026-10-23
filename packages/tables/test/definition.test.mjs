import assert from 'node:assert/strict';
import test from 'node:test';
import {
  definitionSchema,
  validateRecord,
  validateValue,
  fieldSchema,
  valueSchema,
  tableDefinitionMessages,
  tableDefinitionRules,
} from '@tulipfarm/tables/definition';
import { proposeTableSchema, tableProposalMessages, tableProposalRules } from '@tulipfarm/tables/proposal-contracts';

const table = '00000000-0000-4000-8000-000000000001';
const team = '00000000-0000-4000-8000-000000000002';
const field = '00000000-0000-4000-8000-000000000003';
const second = '00000000-0000-4000-8000-000000000004';
const option = '00000000-0000-4000-8000-000000000005';
const record = '00000000-0000-4000-8000-000000000006';
const base = { id: field, label: 'Name', required: false };
const text = { ...base, kind: 'text', maxLength: 10000 };
const definition = (fields = [text], uniqueKeys = []) => ({
  formatVersion: 2,
  id: table,
  owningTeamId: team,
  label: 'Customers',
  fields,
  uniqueKeys,
});

test('logical definitions reject physical names, duplicate identities and invalid composite keys', () => {
  const key = { id: option, fieldIds: [field, second], nulls: 'distinct' };
  const valid = definition([text, { ...text, id: second }], [key]);
  assert.deepEqual(definitionSchema.parse(valid).uniqueKeys, [key]);
  for (const invalid of [
    { ...valid, tableName: 'r_physical' },
    definition([{ ...text, columnName: 'f_physical' }]),
    definition([text, text]),
    definition([text], [key]),
    definition([text], [{ ...key, fieldIds: [field, field] }]),
    definition(valid.fields, [key, { ...key, id: second, fieldIds: [second, field] }]),
    definition([text], [{ ...key, fieldIds: [field], nulls: 'equal' }]),
    definition([{ ...base, kind: 'numeric', precision: 3, scale: 4 }]),
  ])
    assert.equal(definitionSchema.safeParse(invalid).success, false);
});

test('table archive and restore require a reviewed current revision', () => {
  const revision = 'a'.repeat(40);
  for (const kind of ['archive', 'restore'])
    assert.deepEqual(
      proposeTableSchema.parse({ plans: [{ kind, tableId: table, expectedRevision: revision, dependsOn: [] }] })
        .plans[0],
      { kind, tableId: table, expectedRevision: revision, dependsOn: [] },
    );
  for (const expectedRevision of [null, 'not-a-revision'])
    assert.equal(
      proposeTableSchema.safeParse({ plans: [{ kind: 'archive', tableId: table, expectedRevision, dependsOn: [] }] })
        .success,
      false,
    );
});

test('decimal, date, timestamp and required values have exact constraints', () => {
  const numeric = fieldSchema.parse({ ...base, kind: 'numeric', precision: 30, scale: 10 });
  assert.deepEqual(validateValue(numeric, { kind: 'numeric', value: '99999999999999999999.1234567890' }), {
    kind: 'numeric',
    value: '99999999999999999999.1234567890',
  });
  for (const value of [1, '1e2', '01', '100000000000000000000', '0.12345678901'])
    assert.throws(() => validateValue(numeric, { kind: 'numeric', value }));
  const small = fieldSchema.parse({ ...base, kind: 'numeric', precision: 3, scale: 2 });
  assert.deepEqual(validateValue(small, { kind: 'numeric', value: '9.99' }), { kind: 'numeric', value: '9.99' });
  assert.throws(() => validateValue(small, { kind: 'numeric', value: '10.00' }));
  assert.deepEqual(valueSchema.parse({ kind: 'date', value: '2024-02-29' }), { kind: 'date', value: '2024-02-29' });
  for (const value of ['2023-02-29', '2024-02-30', '0000-01-01'])
    assert.equal(valueSchema.safeParse({ kind: 'date', value }).success, false);
  assert.deepEqual(valueSchema.parse({ kind: 'timestamp', value: '2026-10-01T01:30:00+05:30' }), {
    kind: 'timestamp',
    value: '2026-09-30T20:00:00.000Z',
  });
  for (const value of [
    '2026-10-01T01:00:00',
    '2026-10-01T01:00:00.1234Z',
    '2026-10-01T01:00:00+15:00',
    '2026-02-30T01:00:00Z',
  ])
    assert.equal(valueSchema.safeParse({ kind: 'timestamp', value }).success, false);
  assert.deepEqual(validateRecord(definitionSchema.parse(definition()), {}), { [field]: null });
  assert.throws(() => validateRecord(definitionSchema.parse(definition([{ ...text, required: true }])), {}));
  assert.throws(() => validateRecord(definitionSchema.parse(definition()), { [second]: null }));
});

test('select values use stable active option identities rather than labels', () => {
  const options = [
    { id: option, label: 'Open', retired: false },
    { id: record, label: 'Old', retired: true },
  ];
  const single = fieldSchema.parse({ ...base, kind: 'single-select', options });
  assert.deepEqual(validateValue(single, { kind: 'single-select', optionId: option }), {
    kind: 'single-select',
    optionId: option,
  });
  assert.deepEqual(
    validateValue(
      { ...single, options: [{ ...options[0], label: 'New' }] },
      { kind: 'single-select', optionId: option },
    ),
    { kind: 'single-select', optionId: option },
  );
  for (const optionId of ['Open', record, second])
    assert.throws(() => validateValue(single, { kind: 'single-select', optionId }));
  const multi = fieldSchema.parse({ ...base, kind: 'multi-select', options, required: true });
  assert.deepEqual(validateValue(multi, { kind: 'multi-select', optionIds: [option] }), {
    kind: 'multi-select',
    optionIds: [option],
  });
  for (const optionIds of [[], [option, option], [record]])
    assert.throws(() => validateValue(multi, { kind: 'multi-select', optionIds }));
  assert.equal(fieldSchema.safeParse({ ...single, options: [options[0], options[0]] }).success, false);
  assert.equal(
    definitionSchema.safeParse(definition([multi], [{ id: record, fieldIds: [field], nulls: 'distinct' }])).success,
    false,
  );
});

test('relationships support every cardinality pair, optional reverse configuration and restrictive deletion', () => {
  for (const cardinality of ['one', 'many'])
    for (const inverseCardinality of ['one', 'many']) {
      const link = fieldSchema.parse({
        ...base,
        kind: 'relationship',
        targetTableId: table,
        cardinality,
        inverseCardinality,
        reverse: { fieldId: second, label: 'Incoming' },
        onDelete: 'restrict',
      });
      assert.deepEqual(validateValue(link, { kind: 'relationship', tableId: table, recordIds: [record] }), {
        kind: 'relationship',
        tableId: table,
        recordIds: [record],
      });
      assert.deepEqual(definitionSchema.parse(definition([link])).fields[0].reverse, {
        fieldId: second,
        label: 'Incoming',
      });
      assert.throws(() => validateValue(link, { kind: 'relationship', tableId: team, recordIds: [record] }));
      assert.throws(() => validateValue(link, { kind: 'relationship', tableId: table, recordIds: [record, record] }));
      assert.equal(fieldSchema.safeParse({ ...link, onDelete: 'cascade' }).success, false);
      assert.equal(
        definitionSchema.safeParse(definition([{ ...link, reverse: { fieldId: field, label: 'Collision' } }])).success,
        false,
      );
      if (cardinality === 'one')
        assert.throws(() => validateValue(link, { kind: 'relationship', tableId: table, recordIds: [record, option] }));
    }
});

test('file references carry identities without granting access', () => {
  const file = fieldSchema.parse({ ...base, kind: 'file', cardinality: 'many', access: 'independent' });
  assert.deepEqual(validateValue(file, { kind: 'file', fileIds: [record, option] }), {
    kind: 'file',
    fileIds: [record, option],
  });
  assert.equal(fieldSchema.safeParse({ ...file, access: 'table' }).success, false);
  assert.throws(() => validateValue(file, { kind: 'file', fileIds: [record], url: 'https://example.com/private' }));
  assert.throws(() => validateValue({ ...file, cardinality: 'one' }, { kind: 'file', fileIds: [] }));
});

test('record field identities normalize without silently replacing aliased inputs', () => {
  const id = 'abcdef00-0000-4000-8000-000000000003';
  const schema = definitionSchema.parse(definition([{ ...text, id }]));
  assert.deepEqual(validateRecord(schema, { [id.toUpperCase()]: { kind: 'text', value: 'Ada' } }), {
    [id]: { kind: 'text', value: 'Ada' },
  });
  assert.throws(() =>
    validateRecord(schema, {
      [id]: { kind: 'text', value: 'Ada' },
      [id.toUpperCase()]: { kind: 'text', value: 'Grace' },
    }),
  );
});

test('record validation rejects malformed Unicode and enforces reference and numeric boundaries', () => {
  assert.deepEqual(validateValue(text, { kind: 'text', value: '🌷' }), { kind: 'text', value: '🌷' });
  for (const value of ['\u0000', '\uD800', '\uDC00', 'x'.repeat(10001)]) {
    assert.throws(() => validateValue(text, { kind: 'text', value }));
  }
  const decimal = fieldSchema.parse({ ...base, kind: 'numeric', precision: 2, scale: 2 });
  assert.deepEqual(validateValue(decimal, { kind: 'numeric', value: '-0.99' }), { kind: 'numeric', value: '-0.99' });
  assert.throws(() => validateValue(decimal, { kind: 'numeric', value: '1' }));
  assert.throws(() => validateValue({ ...text, required: true }, null));
  const file = fieldSchema.parse({ ...base, kind: 'file', cardinality: 'many', access: 'independent' });
  assert.deepEqual(validateValue(file, { kind: 'file', fileIds: [] }), { kind: 'file', fileIds: [] });
  assert.throws(() => validateValue({ ...file, required: true }, { kind: 'file', fileIds: [] }));
  assert.throws(() => validateValue(file, { kind: 'file', fileIds: [record, record] }));
  for (const timestamp of ['0001-01-01T00:00:00+01:00', '9999-12-31T23:59:59-01:00']) {
    assert.equal(valueSchema.safeParse({ kind: 'timestamp', value: timestamp }).success, false);
  }
});

test('custom rule failures report the exported rule messages', () => {
  const messages = input =>
    definitionSchema.safeParse(input).error.issues.map(({ path, message }) => ({ path, message }));
  assert.deepEqual(messages(definition([text, text])), [
    { path: ['fields'], message: tableDefinitionMessages.duplicateField },
  ]);
  assert.deepEqual(messages(definition([{ ...base, kind: 'numeric', precision: 3, scale: 5 }])), [
    { path: ['fields', 0], message: tableDefinitionMessages.decimalPrecisionScale },
  ]);
  const plan = { kind: 'schema', tableId: table, expectedRevision: null, dependsOn: [], transforms: { outputs: [] } };
  assert.deepEqual(
    proposeTableSchema
      .safeParse({ plans: [{ ...plan, target: definition([text]), tableId: second }] })
      .error.issues.map(issue => issue.message),
    [tableProposalMessages.targetMismatch],
  );
  const listed = tableProposalRules.map(rule => rule.message);
  for (const message of [...Object.values(tableDefinitionMessages), ...Object.values(tableProposalMessages)])
    assert.ok(listed.includes(message), message);
  assert.ok(tableDefinitionRules.every(rule => tableProposalRules.includes(rule)));
});
