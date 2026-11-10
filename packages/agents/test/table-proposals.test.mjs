import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  blockedArchive,
  importPlanResult,
  missingTransformNote,
  structureOnlyNote,
  tableReviewSummary,
} from '../src/table-proposals.ts';
import { TableImportPlanError } from '@tulipfarm/tables/proposal-contracts';

const revision = 'a'.repeat(40);

test('review summaries use persisted table labels and the matching import source', () => {
  const source = randomUUID();
  const summary = tableReviewSummary(
    [
      {
        input: { kind: 'import', reference: { kind: 'file', attachmentId: source } },
        after: { label: 'Orders' },
        effectCount: 9,
      },
      {
        input: { kind: 'schema', expectedRevision: null },
        after: { label: 'Customers' },
        effectCount: 0,
      },
    ],
    [
      { attachmentId: randomUUID(), filename: 'wrong.csv' },
      { attachmentId: source, filename: 'orders.csv' },
    ],
  );
  assert.match(summary, /Import 9 row changes into "Orders" from "orders.csv"/);
  assert.match(summary, /structure of "Customers".*no rows are included/);
  assert.doesNotMatch(summary, /wrong.csv/);
  assert.match(summary, /Nothing in this card has been applied/);
  const integration = tableReviewSummary(
    [
      {
        input: { kind: 'import', reference: { kind: 'integration', resultId: source } },
        after: { label: 'Tasks' },
        effectCount: 2,
      },
    ],
    [],
  );
  assert.ok(integration.includes(`into "Tasks" from integration result ${source}`));
});

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

test('an import whose values don’t fit names the rows, field, value and next step, not a denial', () => {
  const problem = (row, value) => ({
    row,
    column: 'State',
    fieldId: randomUUID(),
    field: 'Status',
    code: 'unmapped-value',
    value,
    expected: ['Open', 'Done'],
  });
  const result = importPlanResult(
    new TableImportPlanError([problem(2, 'Pending'), problem(7, 'Waiting'), problem(9, 'Hold')], 8),
  );
  assert.equal(result.error, 'import-values-invalid');
  assert.equal(result.total, 8);
  assert.equal(result.truncated, true);
  assert.equal(
    result.reason,
    'No review prepared: 8 values in the file don’t fit the table. Data row 2, column "State": "Pending" isn’t an option of Status (Open, Done). Data row 7, column "State": "Waiting" isn’t an option of Status (Open, Done). Data row 9, column "State": "Hold" isn’t an option of Status (Open, Done). And 5 more. Data rows count from the first row after the header.',
  );
  assert.match(result.instruction, /not a permission denial/);
  assert.match(result.instruction, /never drop, change or guess values/);
  const mapping = importPlanResult(
    new TableImportPlanError([
      {
        row: null,
        column: 'Stat',
        fieldId: randomUUID(),
        field: 'Status',
        code: 'unknown-column',
        value: null,
        expected: ['Name', 'State'],
      },
    ]),
  );
  assert.equal(mapping.error, 'import-mapping-invalid');
  assert.match(mapping.reason, /The file has no column "Stat"\. Its columns are: Name, State\./);
  assert.match(mapping.instruction, /propose again in this reply/);
});
