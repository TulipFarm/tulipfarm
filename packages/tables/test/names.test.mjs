import assert from 'node:assert/strict';
import test from 'node:test';
import { definitionSchema } from '../src/definition.ts';
import { readTableDocument, tableDocument, tableName, tableNameSchema } from '../src/names.ts';

const id = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const team = '33333333-3333-4333-8333-333333333333';
const field = '44444444-4444-4444-8444-444444444444';

test('table names preserve readable words and reserve room for collision suffixes', () => {
  assert.equal(tableName('Customer Orders'), 'customer_orders');
  assert.equal(tableName('TICKETS', 2), 'tickets_2');
  assert.equal(tableName(' Café / 東京 '), 'café_東京');
  assert.equal(tableName('Cafe\u0301'), 'café');
  assert.equal(tableName('Ｆｕｌｌ Width'), 'full_width');
  assert.equal(tableName('!!!'), 'table');
  assert.equal(tableName('../A\\B.git'), 'a_b_git');
  assert.equal(tableName('a'.repeat(120), 12), `${'a'.repeat(77)}_12`);
  for (const invalid of ['', 'ABC', '../tickets', '_tickets', 'tickets_', 'a__b', 'a/b', 'a\u0000b', 'a'.repeat(81)]) {
    assert.equal(tableNameSchema.safeParse(invalid).success, false, invalid);
  }
  assert.throws(() => tableName(''));
  assert.throws(() => tableName('Tickets', 0));
});

test('named table documents round-trip through trusted private UUID bindings', () => {
  const definition = definitionSchema.parse({
    formatVersion: 2,
    id,
    owningTeamId: team,
    label: 'Tickets',
    uniqueKeys: [],
    fields: [
      {
        id: field,
        label: 'Customer',
        required: false,
        kind: 'relationship',
        targetTableId: target,
        cardinality: 'one',
        inverseCardinality: 'many',
        reverse: null,
        onDelete: 'restrict',
      },
    ],
  });
  const names = { [id]: 'tickets', [target]: 'customers' };
  const document = tableDocument(definition, names);
  assert.equal(document.formatVersion, 3);
  assert.equal(document.id, 'tickets');
  assert.equal(document.fields[0].targetTableId, 'customers');
  assert.equal(JSON.stringify(document).includes(id), false);
  assert.equal(JSON.stringify(document).includes(target), false);
  assert.deepEqual(readTableDocument(document, id, names), definition);
  assert.throws(() => readTableDocument({ ...document, id: 'other' }, id, names), /identity mismatch/);
  assert.throws(() => tableDocument(definition, { [id]: 'tickets' }), /Missing trusted table name/);
  assert.throws(() => readTableDocument(document, id, { [id]: 'tickets' }), /Missing trusted relationship identity/);
  assert.throws(() => tableDocument(definition, { [id]: 'tickets', [target]: 'tickets' }));
});
