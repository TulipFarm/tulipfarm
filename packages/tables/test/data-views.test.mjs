import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import {
  dataViewSchema,
  dataViewScope,
  projectValues,
  rangedHiddenField,
  unresolvedDataViewField,
  requireViewQuery,
  requireViewWrite,
} from '@tulipfarm/tables/data-views';

const app = '00000000-0000-4000-8000-0000000000a1';
const tableId = '00000000-0000-4000-8000-000000000001';
const team = '00000000-0000-4000-8000-000000000002';
const name = '00000000-0000-4000-8000-000000000003';
const owner = '00000000-0000-4000-8000-000000000004';
const status = '00000000-0000-4000-8000-000000000005';
const secret = '00000000-0000-4000-8000-000000000006';
const done = '00000000-0000-4000-8000-000000000007';
const files = '00000000-0000-4000-8000-000000000008';
const tags = '00000000-0000-4000-8000-000000000009';
const open = '00000000-0000-4000-8000-00000000000a';

const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: team,
  label: 'Tasks',
  fields: [
    { id: name, kind: 'text', label: 'Name', required: false, maxLength: 200 },
    { id: owner, kind: 'text', label: 'Owner', required: false, maxLength: 200 },
    {
      id: status,
      kind: 'single-select',
      label: 'Status',
      required: false,
      options: [{ id: open, label: 'Open', retired: false }],
    },
    { id: secret, kind: 'text', label: 'Secret', required: false, maxLength: 200 },
    { id: done, kind: 'boolean', label: 'Done', required: false },
    { id: files, kind: 'file', label: 'Files', required: false, cardinality: 'many' },
    { id: tags, kind: 'multi-select', label: 'Tags', required: false, options: [] },
  ],
  uniqueKeys: [],
};

const view = (overrides = {}) =>
  dataViewSchema.parse({
    id: '00000000-0000-4000-8000-0000000000f1',
    appId: app,
    tableId,
    fieldIds: [name, owner, tags],
    predicate: {
      all: [
        { fieldId: owner, op: 'eq', operand: { kind: 'parameter', name: 'owner' } },
        { fieldId: done, op: 'eq', operand: { kind: 'value', value: false } },
        { fieldId: secret, op: 'is-null' },
      ],
    },
    actions: ['read', 'update'],
    ...overrides,
  });

const column = id => `"f_${id.replaceAll('-', '')}"`;

test('a view resolves to its listed fields and a parameterized predicate', () => {
  const scope = dataViewScope(view(), definition, 'read', { owner: 'ada' });
  assert.deepEqual(
    scope.fields.map(field => field.id),
    [name, owner, tags],
  );
  assert.deepEqual(scope.predicates, [`${column(owner)} = $1`, `${column(done)} = $2`, `${column(secret)} IS NULL`]);
  assert.deepEqual(scope.parameters, ['ada', false]);
});

test('an empty predicate reaches every row', () => {
  const scope = dataViewScope(view({ predicate: { all: [] } }), definition, 'read', {});
  assert.deepEqual(scope.predicates, []);
  assert.deepEqual(scope.parameters, []);
});

test('a field added to the table later stays outside the view', () => {
  const added = '00000000-0000-4000-8000-0000000000b1';
  const grown = {
    ...definition,
    fields: [...definition.fields, { id: added, kind: 'text', label: 'Added', required: false, maxLength: 10 }],
  };
  const scope = dataViewScope(view(), grown, 'read', { owner: 'ada' });
  assert.deepEqual(
    scope.fields.map(field => field.id),
    [name, owner, tags],
  );
  assert.deepEqual(
    projectValues(scope, { [name]: { kind: 'text', value: 'a' }, [added]: { kind: 'text', value: 'x' } }),
    {
      [name]: { kind: 'text', value: 'a' },
    },
  );
});

test('every unresolvable view denies', async t => {
  const denies = (label, run) => t.test(label, () => assert.throws(run, AccessDenied));
  const without = id => ({ ...definition, fields: definition.fields.filter(field => field.id !== id) });
  await denies('action not allowed', () => dataViewScope(view(), definition, 'delete', { owner: 'ada' }));
  await denies('another table', () => dataViewScope(view(), { ...definition, id: team }, 'read', { owner: 'ada' }));
  await denies('listed field deleted', () => dataViewScope(view(), without(name), 'read', { owner: 'ada' }));
  await denies('unknown listed field', () =>
    dataViewScope(view({ fieldIds: [name, '00000000-0000-4000-8000-0000000000c1'] }), definition, 'read', {
      owner: 'ada',
    }),
  );
  await denies('predicate field deleted', () => dataViewScope(view(), without(secret), 'read', { owner: 'ada' }));
  await denies('file field listed', () =>
    dataViewScope(view({ fieldIds: [name, files] }), definition, 'read', { owner: 'ada' }),
  );
  await denies('predicate over a multi-choice field', () =>
    dataViewScope(view({ predicate: { all: [{ fieldId: tags, op: 'is-null' }] } }), definition, 'read', {}),
  );
  await denies('parameter missing', () => dataViewScope(view(), definition, 'read', {}));
  await denies('extra parameter', () => dataViewScope(view(), definition, 'read', { owner: 'ada', other: 'x' }));
  await denies('parameter of the wrong kind', () => dataViewScope(view(), definition, 'read', { owner: true }));
  await denies('ordering a boolean', () =>
    dataViewScope(
      view({ predicate: { all: [{ fieldId: done, op: 'lt', operand: { kind: 'value', value: true } }] } }),
      definition,
      'read',
      {},
    ),
  );
  await denies('unknown choice', () =>
    dataViewScope(
      view({ predicate: { all: [{ fieldId: status, op: 'eq', operand: { kind: 'value', value: team } }] } }),
      definition,
      'read',
      {},
    ),
  );
});

test('a view shape is validated where it is parsed', () => {
  assert.throws(() => view({ actions: ['update'] }));
  assert.throws(() => view({ actions: ['delete'] }));
  assert.throws(() => view({ actions: [] }));
  assert.throws(() => view({ actions: ['read', 'read'] }));
  assert.throws(() => view({ actions: ['read', 'restore'] }));
  assert.throws(() => view({ fieldIds: [] }));
  assert.throws(() => view({ fieldIds: [name, name] }));
  assert.throws(() =>
    view({ predicate: { all: [{ fieldId: name, op: 'like', operand: { kind: 'value', value: 'a' } }] } }),
  );
  assert.throws(() => view({ predicate: { sql: 'TRUE' } }));
  assert.throws(() =>
    view({ predicate: { all: [{ fieldId: name, op: 'eq', operand: { kind: 'parameter', name: 'Bad name' } }] } }),
  );
  assert.deepEqual(view({ actions: ['read', 'create', 'update', 'delete'] }).actions, [
    'read',
    'create',
    'update',
    'delete',
  ]);
  assert.deepEqual(view({ actions: ['create'] }).actions, ['create']);
});

test('queries and writes stay on view fields', () => {
  const scope = dataViewScope(view(), definition, 'read', { owner: 'ada' });
  const query = { filters: [], limit: 50 };
  assert.doesNotThrow(() =>
    requireViewQuery(scope, {
      ...query,
      filters: [{ fieldId: name, op: 'eq', value: 'a' }],
      sort: { fieldId: owner, direction: 'asc' },
    }),
  );
  assert.throws(
    () => requireViewQuery(scope, { ...query, filters: [{ fieldId: secret, op: 'is-null' }] }),
    AccessDenied,
  );
  assert.throws(() => requireViewQuery(scope, { ...query, sort: { fieldId: secret, direction: 'asc' } }), AccessDenied);
  assert.doesNotThrow(() => requireViewWrite(scope, { [name]: { kind: 'text', value: 'a' } }));
  assert.throws(() => requireViewWrite(scope, { [secret]: { kind: 'text', value: 'x' } }), AccessDenied);
});

test('responses carry only view fields', () => {
  const scope = dataViewScope(view(), definition, 'read', { owner: 'ada' });
  assert.deepEqual(
    projectValues(scope, {
      [name]: { kind: 'text', value: 'a' },
      [secret]: { kind: 'text', value: 'hidden' },
      [done]: { kind: 'boolean', value: false },
    }),
    { [name]: { kind: 'text', value: 'a' } },
  );
});

test('a parameter may compare a hidden field only for equality', async t => {
  const compare = (fieldId, op, operand) => ({ all: [{ fieldId, op, operand }] });
  const parameter = { kind: 'parameter', name: 'probe' };
  for (const op of ['ne', 'lt', 'lte', 'gt', 'gte'])
    await t.test(`${op} on a hidden field is refused`, () => {
      const predicate = compare(secret, op, parameter);
      assert.equal(rangedHiddenField({ fieldIds: [name], predicate }), secret);
      assert.throws(() => view({ predicate }), /only test a field the view does not list for equality/);
    });
  await t.test('eq on a hidden field, a literal, and a listed field are allowed', () => {
    const predicates = [
      compare(secret, 'eq', parameter),
      compare(secret, 'gt', { kind: 'value', value: 'm' }),
      compare(name, 'gt', parameter),
    ];
    assert.deepEqual(
      predicates.map(predicate => rangedHiddenField({ fieldIds: [name], predicate })),
      [undefined, undefined, undefined],
    );
    assert.deepEqual(
      predicates.map(predicate => view({ fieldIds: [name], predicate }).predicate),
      predicates,
    );
  });
});

test('creation names the first field a view cannot use', () => {
  const draft = (fieldIds, predicate = { all: [] }) => ({ fieldIds, predicate });
  assert.equal(unresolvedDataViewField(draft([name, tags]), definition), undefined);
  assert.equal(unresolvedDataViewField(draft([name, files]), definition), files);
  assert.equal(unresolvedDataViewField(draft([name, team]), definition), team);
  assert.equal(
    unresolvedDataViewField(draft([name], { all: [{ fieldId: tags, op: 'is-null' }] }), definition),
    tags,
    'a multi-choice field cannot be in the predicate',
  );
});
