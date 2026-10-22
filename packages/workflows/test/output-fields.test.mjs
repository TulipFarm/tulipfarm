import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authoredDefinitionSchema,
  definitionSchema,
  outputAt,
  outputChoices,
  outputPathIssues,
  sampledOutputChoices,
  stepOutputShapes,
  transform,
} from '../src/contracts.ts';

const id = '11111111-1111-4111-8111-111111111111';
const literal = value => ({ kind: 'literal', value });
const input = { kind: 'input', path: [] };
const ref = (step, path) => ({ kind: 'step', step, path });
const definition = steps => ({ version: 1, name: 'Outputs', trigger: { kind: 'manual' }, steps });
const check = (source, path) =>
  authoredDefinitionSchema.safeParse(
    definition([source, { id: 'copy', kind: 'transform', fields: { value: ref(source.id, path) } }]),
  );

test('successful output descriptions cover every supported kind without guessing dynamic outputs', () => {
  const sources = [
    [{ id: 'source', kind: 'transform', fields: { total: literal(12), data: input } }, ['total'], ['nope']],
    [
      { id: 'source', kind: 'http', method: 'GET', url: 'https://example.com', headers: {} },
      ['headers', 'content-type'],
      ['body', 'total'],
    ],
    [
      {
        id: 'source',
        kind: 'condition',
        when: { left: literal(1), op: 'eq', right: literal(1) },
        ifMet: ['copy'],
        otherwise: [],
      },
      ['ran', '0'],
      ['matched', 'x'],
    ],
    [{ id: 'source', kind: 'agent', agentId: id, prompt: literal('Hello') }, ['result'], ['result', 'text']],
    [{ id: 'source', kind: 'slack-message', destinationId: id, text: literal('Hello') }, ['sentMessageTs'], ['result']],
    [
      { id: 'source', kind: 'find-rows', tableId: id, filters: [], limit: 5 },
      ['rows', '3', 'values', id],
      ['rows', 'values'],
    ],
    [
      { id: 'source', kind: 'create-row', tableId: id, fields: { [id]: literal('Hello') } },
      ['recordId'],
      ['values', id],
    ],
    [
      { id: 'source', kind: 'update-row', tableId: id, row: input, fields: { [id]: literal('Hello') } },
      ['token'],
      ['rows', '0'],
    ],
    [{ id: 'source', kind: 'delay', seconds: 1 }, [], ['value']],
    [{ id: 'source', kind: 'wait-until', at: literal('2027-01-31') }, [], ['at']],
  ];
  for (const [source, valid, invalid] of sources) {
    assert.equal(check(source, valid).success, true, `${source.kind} accepts its real field`);
    assert.equal(check(source, invalid).success, false, `${source.kind} rejects an impossible field`);
    assert.equal(
      definitionSchema.safeParse(
        definition([source, { id: 'copy', kind: 'transform', fields: { value: ref(source.id, invalid) } }]),
      ).success,
      true,
      `${source.kind} historical definitions are unchanged`,
    );
  }
  for (const source of [
    { id: 'source', kind: 'human', prompt: 'Answer', timeoutSeconds: 60 },
    { id: 'source', kind: 'code', language: 'javascript', source: 'return input', input },
  ]) {
    assert.equal(check(source, ['any.field', '0', 'future']).success, true);
    assert.deepEqual(outputChoices(stepOutputShapes([source]).get(source.id)), [
      { path: [], label: 'Whole output', hint: false },
    ]);
  }
});

test('transforms carry declared fields and nested known shapes, preserving unknown data and literal dots', () => {
  const source = {
    id: 'source',
    kind: 'transform',
    fields: { details: literal({ 'due.date': '2027-01-31', nested: { total: 12 } }), dynamic: input },
  };
  assert.equal(check(source, ['details', 'due.date']).success, true);
  assert.equal(check(source, ['details', 'due', 'date']).success, false);
  assert.equal(check(source, ['details', 'nested', 'missing']).success, false);
  assert.equal(check(source, ['dynamic', 'unknown', '0']).success, true);
  assert.equal(check(source, ['details', 'due.date', 'length']).success, false, 'runtime cannot descend into a string');
  const copy = { id: 'copy', kind: 'transform', fields: { data: ref('source', ['details']) } };
  const third = { id: 'third', kind: 'transform', fields: { total: ref('copy', ['data', 'missing']) } };
  assert.equal(authoredDefinitionSchema.safeParse(definition([source, copy, third])).success, false);
  const shape = stepOutputShapes([source]).get('source');
  const picked = outputChoices(shape).find(choice => choice.label === 'details / due.date');
  assert.deepEqual(picked.path, ['details', 'due.date']);
  assert.deepEqual(
    transform(
      { id: 'copy', kind: 'transform', fields: { date: ref('source', picked.path) } },
      {},
      new Map([['source', transform(source, {}, new Map())]]),
    ),
    { date: '2027-01-31' },
  );
});

test('live table fields supply readable labels and exact typed value shapes, never file fields', () => {
  const fields = [
    { id: 'amount', label: 'Invoice total', kind: 'numeric' },
    { id: 'state', label: 'State', kind: 'single-select' },
    { id: 'tags', label: 'Tags', kind: 'multi-select' },
    { id: 'links', label: 'Customers', kind: 'relationship' },
    { id: 'file', label: 'Secret file', kind: 'file' },
  ];
  const source = { id: 'find', kind: 'find-rows', tableId: id, filters: [], limit: 5 };
  const shapes = stepOutputShapes([source], [{ id, fields }]),
    shape = shapes.get('find');
  const choices = outputChoices(shape);
  assert.deepEqual(choices.find(choice => choice.label.endsWith('Invoice total / value')).path, [
    'rows',
    '0',
    'values',
    'amount',
    'value',
  ]);
  assert.equal(
    choices.some(choice => choice.label.includes('Secret file')),
    false,
  );
  const hints = sampledOutputChoices(shape, 'find', id, [
    {
      revision: id,
      status: 'completed',
      steps: [
        {
          stepId: 'find',
          status: 'completed',
          output: { rows: [{}, { values: { amount: { kind: 'numeric', value: '12.00' } } }] },
        },
      ],
    },
  ]);
  assert.ok(hints.some(hint => hint.label === 'rows / Item 2 (1) / values / Invoice total / value (run hint)'));
  for (const path of [
    ['rows', '2', 'values', 'amount', 'value'],
    ['rows', '0', 'values', 'state', 'optionId'],
    ['rows', '0', 'values', 'links', 'recordIds', '0'],
    ['rows', 'length'],
  ])
    assert.ok(outputAt(shape, path));
  for (const path of [
    ['rows', '-1'],
    ['rows', '0', 'values', 'missing'],
    ['rows', '0', 'values', 'file'],
    ['rows', '0', 'values', 'state', 'value'],
    ['rows', '0', 'values', 'amount', 'value', 'nested'],
  ]) {
    const value = definition([source, { id: 'copy', kind: 'transform', fields: { total: ref('find', path) } }]);
    assert.equal(outputPathIssues(value, [{ id, fields }]).length, 1);
  }
  assert.ok(
    outputAt(stepOutputShapes([source]).get('find'), ['rows', '0', 'values', 'unloaded', 'nested']),
    'unloaded table metadata is not a closed schema',
  );
});

test('every reference-bearing location receives a precise authored field issue', () => {
  const source = { id: 'source', kind: 'transform', fields: { total: literal(1) } };
  const bad = ref('source', ['missing']);
  const cases = [
    [{ id: 'copy', kind: 'transform', fields: { total: bad } }, ['fields', 'total']],
    [{ id: 'copy', kind: 'code', language: 'javascript', source: 'return input', input: bad }, ['input']],
    [{ id: 'copy', kind: 'agent', agentId: id, prompt: bad }, ['prompt']],
    [{ id: 'copy', kind: 'slack-message', destinationId: id, text: bad }, ['text']],
    [
      { id: 'copy', kind: 'http', method: 'POST', url: 'https://example.com', headers: { 'x-value': bad }, body: bad },
      ['headers', 'x-value'],
    ],
    [{ id: 'copy', kind: 'wait-until', at: bad }, ['at']],
    [
      { id: 'copy', kind: 'find-rows', tableId: id, filters: [{ fieldId: id, op: 'eq', value: bad }], limit: 5 },
      ['filters', 0, 'value'],
    ],
    [{ id: 'copy', kind: 'create-row', tableId: id, fields: { [id]: bad } }, ['fields', id]],
    [{ id: 'copy', kind: 'update-row', tableId: id, row: bad, fields: { [id]: bad } }, ['row']],
    [
      { id: 'copy', kind: 'condition', when: { left: bad, op: 'eq', right: bad }, ifMet: ['end'], otherwise: [] },
      ['when', 'left'],
    ],
  ];
  for (const [step, path] of cases) {
    const result = authoredDefinitionSchema.safeParse(
      definition([source, step, { id: 'end', kind: 'delay', seconds: 1 }]),
    );
    assert.equal(result.success, false);
    assert.deepEqual(result.error.issues[0].path, ['steps', 1, ...path, 'path']);
    assert.match(result.error.issues[0].message, /copy.*source.*missing/);
  }
});

test('history hints use only visible successful matching-revision receipts and never become validation rules', () => {
  const source = { id: 'source', kind: 'human', prompt: 'Answer', timeoutSeconds: 60 };
  const shape = stepOutputShapes([source]).get('source');
  const run = (revision, status, output, receiptStatus = 'completed') => ({
    revision,
    status,
    steps: [{ stepId: 'source', status: receiptStatus, output }],
  });
  const hints = sampledOutputChoices(shape, 'source', id, [
    run(id, 'completed', { 'answer.code': 'PRIVATE_VALUE', rows: [{ total: 12 }] }),
    run('old', 'completed', { old: true }),
    run(id, 'failed', { failed: true }),
    run(id, 'completed', { waiting: true }, 'waiting'),
    run(id, 'completed', { withheld: 'source-access' }),
  ]);
  assert.ok(hints.some(hint => JSON.stringify(hint.path) === '["answer.code"]'));
  assert.ok(hints.some(hint => JSON.stringify(hint.path) === '["rows","0","total"]'));
  assert.equal(JSON.stringify(hints).includes('PRIVATE_VALUE'), false);
  for (const forbidden of ['old', 'failed', 'waiting', 'withheld', 'source-access'])
    assert.equal(
      hints.some(hint => hint.path.includes(forbidden)),
      false,
    );
  assert.equal(check(source, ['future', 'unseen']).success, true);
  assert.deepEqual(sampledOutputChoices(shape, 'source', null, [run(id, 'completed', { private: true })]), []);
  const http = stepOutputShapes([
    { id: 'source', kind: 'http', method: 'GET', url: 'https://example.com', headers: {} },
  ]).get('source');
  assert.deepEqual(
    sampledOutputChoices(http, 'source', id, [run(id, 'completed', { body: { total: 12 } })]),
    [],
    'a sample never overrides the HTTP text contract',
  );
});
