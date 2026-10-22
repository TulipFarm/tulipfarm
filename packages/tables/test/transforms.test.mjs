import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateTransforms,
  expressionSchema,
  transformsSchema,
  transformResultSchema,
} from '@tulipfarm/tables/transforms';

const table = '00000000-0000-4000-8000-000000000001';
const team = '00000000-0000-4000-8000-000000000002';
const a = '00000000-0000-4000-8000-000000000003';
const b = '00000000-0000-4000-8000-000000000004';
const c = '00000000-0000-4000-8000-000000000005';
const option = '00000000-0000-4000-8000-000000000006';
const value = text => ({ kind: 'text', value: text });
const literal = text => ({ op: 'literal', value: value(text) });
const source = { op: 'field', fieldId: a };
const field = (id, kind = 'text', extra = {}) => ({
  id,
  label: 'Field',
  required: false,
  kind,
  ...(kind === 'text' ? { maxLength: 10000 } : {}),
  ...extra,
});
const target = fields => ({
  formatVersion: 2,
  id: table,
  owningTeamId: team,
  label: 'Records',
  fields,
  uniqueKeys: [],
});
const run = (expression, input = value('hello'), output = field(b)) =>
  evaluateTransforms({
    transforms: { outputs: [{ fieldId: b, expression }] },
    values: { [a]: input },
    target: target([output]),
  });
const convert = (to, onError = 'error') => ({ op: 'convert', input: source, to, timezone: 'UTC', onError });

test('splits one immutable input into multiple outputs and carries unrelated fields', () => {
  const result = evaluateTransforms({
    values: { [a]: value(' Ada Lovelace '), [c]: value('unchanged') },
    target: target([field(a), field(b), field(c)]),
    transforms: {
      outputs: [
        {
          fieldId: a,
          expression: { op: 'split', input: { op: 'trim', input: source }, separator: ' ', index: 0, missing: 'error' },
        },
        {
          fieldId: b,
          expression: { op: 'split', input: { op: 'trim', input: source }, separator: ' ', index: 1, missing: 'error' },
        },
      ],
    },
  });
  assert.deepEqual(result, {
    ok: true,
    values: { [a]: value('Ada'), [b]: value('Lovelace'), [c]: value('unchanged') },
  });
  assert.deepEqual(run({ op: 'join', inputs: [literal('Ada'), literal('Lovelace')], separator: ' ' }), {
    ok: true,
    values: { [b]: value('Ada Lovelace') },
  });
});

test('converts exact decimals, booleans, dates and timezone-aware timestamps', () => {
  assert.deepEqual(
    run(
      convert('numeric'),
      value('99999999999999999999.1234567890'),
      field(b, 'numeric', { precision: 30, scale: 10 }),
    ),
    { ok: true, values: { [b]: { kind: 'numeric', value: '99999999999999999999.1234567890' } } },
  );
  assert.deepEqual(run(convert('boolean'), { kind: 'numeric', value: '1.000' }, field(b, 'boolean')), {
    ok: true,
    values: { [b]: { kind: 'boolean', value: true } },
  });
  assert.deepEqual(run(convert('text'), { kind: 'numeric', value: '1.2300' }), {
    ok: true,
    values: { [b]: value('1.2300') },
  });
  assert.deepEqual(
    run(convert('timestamp'), value('2026-10-01T01:00:00+02:00'), field(b, 'timestamp', { timezone: 'UTC' })),
    { ok: true, values: { [b]: { kind: 'timestamp', value: '2026-09-30T23:00:00.000Z' } } },
  );
  assert.deepEqual(
    run(convert('timestamp'), { kind: 'date', value: '2024-02-29' }, field(b, 'timestamp', { timezone: 'UTC' })),
    { ok: true, values: { [b]: { kind: 'timestamp', value: '2024-02-29T00:00:00.000Z' } } },
  );
  assert.deepEqual(run(convert('date'), { kind: 'timestamp', value: '2026-10-01T01:00:00+02:00' }, field(b, 'date')), {
    ok: true,
    values: { [b]: { kind: 'date', value: '2026-09-30' } },
  });
  for (const text of ['1e2', ' 1 ', 'NaN', '0.12345678901'])
    assert.equal(run(convert('numeric'), value(text)).error.code, 'conversion-failed');
  for (const text of ['yes', 'TRUE', '1'])
    assert.equal(run(convert('boolean'), value(text)).error.code, 'conversion-failed');
  assert.equal(run(convert('timestamp'), value('2026-10-01T01:00:00')).error.code, 'conversion-failed');
});

test('maps typed option and link values with explicit unmatched behavior', () => {
  const expression = {
    op: 'map',
    input: source,
    cases: [{ from: value('open'), to: { kind: 'single-select', optionId: option } }],
    unmatched: 'error',
  };
  const select = field(b, 'single-select', { options: [{ id: option, label: 'Open', retired: false }] });
  assert.deepEqual(run(expression, value('open'), select), {
    ok: true,
    values: { [b]: { kind: 'single-select', optionId: option } },
  });
  assert.equal(run(expression, value('missing'), select).error.code, 'unmapped-value');
  assert.deepEqual(run({ ...expression, unmatched: 'null' }, value('missing'), select), {
    ok: true,
    values: { [b]: null },
  });
  assert.deepEqual(run({ ...expression, unmatched: 'preserve' }, value('keep')), {
    ok: true,
    values: { [b]: value('keep') },
  });
  const link = { kind: 'relationship', tableId: table, recordIds: [option] };
  assert.deepEqual(
    run(
      { ...expression, cases: [{ from: { kind: 'single-select', optionId: option }, to: link }] },
      { kind: 'single-select', optionId: option },
      field(b, 'relationship', {
        targetTableId: table,
        cardinality: 'one',
        inverseCardinality: 'many',
        reverse: null,
        onDelete: 'restrict',
      }),
    ),
    { ok: true, values: { [b]: link } },
  );
  assert.deepEqual(
    run(
      { ...expression, cases: [{ from: { kind: 'numeric', value: '1.00' }, to: value('matched') }] },
      { kind: 'numeric', value: '1' },
    ),
    { ok: true, values: { [b]: value('matched') } },
  );
});

test('null propagation and defaults never hide errors or treat empty text as missing', () => {
  assert.deepEqual(run({ op: 'default', input: source, fallback: literal('fallback') }, null), {
    ok: true,
    values: { [b]: value('fallback') },
  });
  assert.deepEqual(run({ op: 'default', input: source, fallback: { op: 'field', fieldId: c } }, value('')), {
    ok: true,
    values: { [b]: value('') },
  });
  assert.equal(
    run({ op: 'default', input: { op: 'field', fieldId: c }, fallback: literal('fallback') }).error.code,
    'missing-field',
  );
  for (const expression of [
    { op: 'trim', input: source },
    { op: 'join', inputs: [source, literal('x')], separator: ' ' },
    convert('text'),
  ])
    assert.deepEqual(run(expression, null), { ok: true, values: { [b]: null } });
  assert.deepEqual(run(convert('numeric', 'null'), value('bad'), field(b, 'numeric', { precision: 30, scale: 10 })), {
    ok: true,
    values: { [b]: null },
  });
  assert.equal(
    run(convert('numeric', 'null'), value('bad'), field(b, 'numeric', { precision: 30, scale: 10, required: true }))
      .error.code,
    'invalid-output',
  );
  assert.equal(run({ op: 'trim', input: source }, { kind: 'boolean', value: true }).error.code, 'type-mismatch');
  const split = { op: 'split', input: source, separator: ' ', index: 1, missing: 'error' };
  assert.equal(run(split).error.code, 'split-index');
  assert.deepEqual(run({ ...split, missing: 'null' }), { ok: true, values: { [b]: null } });
});

test('typed literals preserve multi-select and file identities and maps compare sets', () => {
  const options = [
    { id: option, label: 'Open', retired: false },
    { id: c, label: 'Urgent', retired: false },
  ];
  const multi = { kind: 'multi-select', optionIds: [option, c] };
  assert.deepEqual(run({ op: 'literal', value: multi }, null, field(b, 'multi-select', { options })), {
    ok: true,
    values: { [b]: multi },
  });
  const file = { kind: 'file', fileIds: [option] };
  assert.deepEqual(
    run({ op: 'literal', value: file }, null, field(b, 'file', { cardinality: 'one', access: 'independent' })),
    { ok: true, values: { [b]: file } },
  );
  const mapping = { op: 'map', input: source, cases: [{ from: multi, to: value('both') }], unmatched: 'error' };
  assert.deepEqual(run(mapping, { kind: 'multi-select', optionIds: [c, option] }), {
    ok: true,
    values: { [b]: value('both') },
  });
  assert.equal(
    run({ ...mapping, cases: [{ from: value('true'), to: value('text') }] }, { kind: 'boolean', value: true }).error
      .code,
    'unmapped-value',
  );
  assert.equal(run(convert('text'), file).error.code, 'conversion-failed');
});

test('rejects malformed inputs, ambiguous maps, unknown targets and invalid outputs', () => {
  for (const expression of [
    { op: 'eval', code: 'process.exit()' },
    { op: 'trim' },
    { ...source, extra: true },
    { ...convert('text'), timezone: 'local' },
    { op: 'split', input: source, separator: '', index: 0, missing: 'null' },
  ])
    assert.equal(run(expression).error.code, 'invalid-input');
  assert.equal(run(source, { kind: 'numeric', value: 2 }).error.code, 'invalid-input');
  const outputs = [{ fieldId: b, expression: literal('x') }];
  assert.equal(transformsSchema.safeParse({ outputs: [...outputs, ...outputs] }).success, false);
  assert.equal(
    evaluateTransforms({ transforms: { outputs }, values: {}, target: target([field(a)]) }).error.code,
    'invalid-output',
  );
  assert.equal(run(literal('too long'), null, field(b, 'text', { maxLength: 3 })).error.code, 'invalid-output');
  assert.equal(
    expressionSchema.safeParse({
      op: 'map',
      input: source,
      cases: [
        { from: { kind: 'numeric', value: '1.0' }, to: null },
        { from: { kind: 'numeric', value: '1.00' }, to: null },
      ],
      unmatched: 'error',
    }).success,
    false,
  );
});

test('bounds recursion, total expressions, cycles, output count and intermediate growth', () => {
  let expression = literal('x');
  for (let index = 0; index < 15; index++) expression = { op: 'trim', input: expression };
  assert.deepEqual(run(expression), { ok: true, values: { [b]: value('x') } });
  assert.equal(run({ op: 'trim', input: expression }).error.code, 'invalid-input');
  const cycle = { op: 'trim' };
  cycle.input = cycle;
  assert.equal(run(cycle).error.code, 'invalid-input');
  const wide = {
    op: 'join',
    separator: '',
    inputs: Array.from({ length: 4 }, () => ({
      op: 'join',
      separator: '',
      inputs: Array.from({ length: 64 }, () => literal('x')),
    })),
  };
  assert.equal(run(wide).error.code, 'invalid-input');
  assert.equal(
    run({ op: 'join', separator: '', inputs: [literal('a'.repeat(10000)), literal('b')] }).error.code,
    'invalid-output',
  );
  assert.equal(
    transformsSchema.safeParse({
      outputs: Array.from({ length: 65 }, () => ({ fieldId: b, expression: literal('x') })),
    }).success,
    false,
  );
  let deep = literal('x');
  for (let index = 0; index < 10000; index++) deep = { op: 'trim', input: deep };
  assert.equal(run(deep).error.code, 'invalid-input');
});

test('schema-only transformations carry retained fields, remove dropped fields and initialize optional fields', () => {
  assert.deepEqual(
    evaluateTransforms({
      transforms: { outputs: [] },
      values: { [a]: value('retained'), [b]: value('removed') },
      target: target([field(a), field(c)]),
    }),
    { ok: true, values: { [a]: value('retained'), [c]: null } },
  );
  assert.deepEqual(
    evaluateTransforms({
      transforms: { outputs: [] },
      values: { [a]: value('removed') },
      target: target([]),
    }),
    { ok: true, values: {} },
  );
  assert.equal(
    evaluateTransforms({
      transforms: { outputs: [] },
      values: {},
      target: target([field(a, 'text', { required: true })]),
    }).error.code,
    'invalid-output',
  );
});

test('ambiguous normalized source identities fail instead of choosing a value', () => {
  const id = 'abcdef00-0000-4000-8000-000000000003';
  const input = {
    transforms: { outputs: [{ fieldId: b, expression: { op: 'field', fieldId: id } }] },
    values: { [id.toUpperCase()]: value('Ada') },
    target: target([field(b)]),
  };
  assert.deepEqual(evaluateTransforms(input), { ok: true, values: { [b]: value('Ada') } });
  assert.equal(
    evaluateTransforms({ ...input, values: { ...input.values, [id]: value('Grace') } }).error.code,
    'invalid-input',
  );
});

test('evaluation is replayable, does not mutate inputs and never returns partial output on failure', () => {
  const input = {
    transforms: {
      outputs: [
        { fieldId: a, expression: literal('changed') },
        { fieldId: b, expression: source },
      ],
    },
    values: { [a]: value('original') },
    target: target([field(a), field(b)]),
  };
  const before = structuredClone(input);
  const expected = { ok: true, values: { [a]: value('changed'), [b]: value('original') } };
  for (let replay = 0; replay < 3; replay++) {
    assert.deepEqual(transformResultSchema.parse(evaluateTransforms(input)), expected);
  }
  assert.deepEqual(
    evaluateTransforms({ ...input, transforms: { outputs: [...input.transforms.outputs].reverse() } }),
    expected,
  );
  const result = evaluateTransforms(input);
  result.values[a].value = 'caller mutation';
  assert.deepEqual(input, before);
  assert.deepEqual(
    evaluateTransforms({
      ...input,
      transforms: { outputs: [input.transforms.outputs[0], { fieldId: b, expression: { op: 'field', fieldId: c } }] },
    }),
    { ok: false, error: { code: 'missing-field', message: 'Source field is missing', fieldId: b } },
  );
  assert.deepEqual(input, before);
});

test('accepts the exact expression and mapping budgets and rejects one extra', () => {
  const expressions = Array.from({ length: 64 }, () => ({ op: 'trim', input: { op: 'trim', input: literal('x') } }));
  const expression = { op: 'join', separator: '', inputs: expressions };
  const outputs = [
    { fieldId: b, expression },
    ...Array.from({ length: 63 }, (_, index) => ({
      fieldId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      expression: literal('x'),
    })),
  ];
  const input = { transforms: { outputs }, values: {}, target: target(outputs.map(output => field(output.fieldId))) };
  assert.deepEqual(evaluateTransforms(input), {
    ok: true,
    values: Object.fromEntries(
      outputs.map((output, index) => [output.fieldId, value(index === 0 ? 'x'.repeat(64) : 'x')]),
    ),
  });
  assert.equal(
    evaluateTransforms({
      ...input,
      transforms: {
        outputs: outputs.map((output, index) =>
          index === 1 ? { ...output, expression: { op: 'trim', input: output.expression } } : output,
        ),
      },
    }).error.code,
    'invalid-input',
  );
  const cases = Array.from({ length: 256 }, (_, index) => ({ from: value(String(index)), to: value('mapped') }));
  const mapping = { op: 'map', input: source, cases, unmatched: 'error' };
  assert.deepEqual(run(mapping, value('255')), { ok: true, values: { [b]: value('mapped') } });
  assert.equal(run({ ...mapping, cases: [...cases, { from: value('256'), to: null }] }).error.code, 'invalid-input');
});

test('option retirement blocks unchanged records but explicit mapping produces a valid replacement', () => {
  const oldOption = { kind: 'single-select', optionId: c };
  const newOption = { kind: 'single-select', optionId: option };
  const select = field(a, 'single-select', {
    options: [
      { id: c, label: 'Old', retired: true },
      { id: option, label: 'Open', retired: false },
    ],
  });
  const input = { values: { [a]: oldOption }, target: target([select]) };
  assert.deepEqual(evaluateTransforms({ ...input, transforms: { outputs: [] } }), {
    ok: false,
    error: { code: 'invalid-output', message: 'Transformed field does not satisfy the target definition', fieldId: a },
  });
  assert.deepEqual(
    evaluateTransforms({
      ...input,
      transforms: {
        outputs: [
          {
            fieldId: a,
            expression: {
              op: 'map',
              input: source,
              cases: [{ from: oldOption, to: newOption }],
              unmatched: 'error',
            },
          },
        ],
      },
    }),
    { ok: true, values: { [a]: newOption } },
  );
});
