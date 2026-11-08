import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { blockedArchive, missingTransformNote, structureOnlyNote } from '../src/table-proposals.ts';

const revision = 'a'.repeat(40);

test('a proposal that creates a table without rows says the rows are not included', () => {
  const note = structureOnlyNote({ plans: [{ kind: 'schema', expectedRevision: null }] });
  assert.equal(note.rowsIncluded, false);
  assert.match(note.instruction, /rows are not in this review/);
});

test('proposals that bring rows or change an existing table carry no structure-only note', () => {
  for (const plans of [
    [{ kind: 'schema', expectedRevision: revision }],
    [{ kind: 'import', expectedRevision: revision }],
    [
      { kind: 'schema', expectedRevision: null },
      { kind: 'records', expectedRevision: revision },
    ],
    [{ kind: 'archive', expectedRevision: revision }],
  ])
    assert.deepEqual(structureOnlyNote({ plans }), {}, JSON.stringify(plans));
});

const tableId = 'a1111111-1111-4111-8111-111111111111';
const amount = 'b2222222-2222-4222-8222-222222222222';
const status = 'c3333333-3333-4333-8333-333333333333';
const blocked = (...records) => ({
  status: 'blocked',
  error: 'invalid-transform',
  tableId,
  records: records.map(([fieldId, code], index) => ({ recordId: `d${index}`, fieldId, code })),
});
const schemaPlan = outputs => ({
  plans: [{ kind: 'schema', tableId, expectedRevision: revision, transforms: { outputs } }],
});
const convert = fieldId => ({
  fieldId,
  expression: { op: 'convert', input: { op: 'field', fieldId }, to: 'numeric', timezone: 'UTC', onError: 'error' },
});

test('a blocked kind change without a transform output tells the agent to add a conversion', () => {
  const note = missingTransformNote(
    blocked([amount, 'invalid-output'], [amount, 'invalid-output'], [status, 'conversion-failed']),
    schemaPlan([convert(status)]),
  );
  assert.deepEqual(note.fieldsWithoutTransform, [amount]);
  assert.match(note.transformInstruction, /"op":"convert"/);
  assert.match(note.transformInstruction, /never tell the person that conversion is unsupported/);
});

test('rows that fail an attached conversion carry no missing-transform note', () => {
  for (const [report, input] of [
    [blocked([amount, 'conversion-failed']), schemaPlan([convert(amount)])],
    [blocked([amount, 'invalid-output']), schemaPlan([convert(amount)])],
    [blocked([null, 'invalid-output']), schemaPlan([])],
    [blocked([amount, 'invalid-output']), { plans: [{ kind: 'import', tableId }] }],
  ])
    assert.deepEqual(missingTransformNote(report, input), {}, JSON.stringify({ report, input }));
});

test('a blocked archive names the readable workflows and otherwise keeps the generic reason', async () => {
  const tableId = randomUUID();
  const input = { plans: [{ kind: 'archive', tableId, dependsOn: [], expectedRevision: revision }] };
  const workflow = { id: randomUUID(), name: 'Weekly summary', url: '/acme/workflows/w' };
  const named = await blockedArchive('workflow-active', input, async id => (id === tableId ? [workflow] : []));
  assert.deepEqual(named.workflows, [workflow]);
  assert.match(named.instruction, /Name and link each workflow/);
  for (const workflowsUsing of [undefined, async () => [], async () => Promise.reject(new Error('unavailable'))]) {
    const generic = await blockedArchive('workflow-active', input, workflowsUsing);
    assert.deepEqual(Object.keys(generic), ['error', 'instruction']);
    assert.match(generic.instruction, /an enabled workflow uses this table/);
  }
});
