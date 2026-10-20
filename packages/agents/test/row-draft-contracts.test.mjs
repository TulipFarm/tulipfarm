import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { authoringProposalSchema, draftOutcomeSchema, draftViewSchema } from '../src/draft-contracts.ts';

const tableId = randomUUID(),
  fieldId = randomUUID(),
  recordId = randomUUID(),
  token = randomUUID();
const revision = 'a'.repeat(40),
  option = randomUUID();

test('row drafts carry exactly one rows.create, rows.update or rows.delete call', () => {
  const calls = [
    {
      tool: 'rows.create',
      tableId,
      expectedAppliedRevision: revision,
      values: { [fieldId]: { kind: 'text', value: 'Note' } },
    },
    {
      tool: 'rows.update',
      tableId,
      expectedAppliedRevision: revision,
      recordId,
      expectedToken: token,
      values: { [fieldId]: null },
    },
    { tool: 'rows.delete', tableId, expectedAppliedRevision: revision, recordId, expectedToken: token },
  ];
  for (const input of calls)
    assert.deepEqual(authoringProposalSchema.parse({ kind: 'row', input }), { kind: 'row', input });
  assert.throws(() =>
    authoringProposalSchema.parse({
      kind: 'row',
      input: { tool: 'rows.create.batch', tableId, expectedAppliedRevision: revision, rows: [] },
    }),
  );
  assert.throws(() => authoringProposalSchema.parse({ kind: 'row', targetId: tableId, input: calls[0] }));
  assert.throws(() => authoringProposalSchema.parse({ kind: 'row', input: { ...calls[2], values: {} } }));
});

test('row draft outcomes and views name the operation, row and labelled table', () => {
  for (const operation of ['create', 'update', 'delete'])
    assert.equal(draftOutcomeSchema.parse({ kind: 'row', operation, recordId }).operation, operation);
  assert.throws(() => draftOutcomeSchema.parse({ kind: 'row', operation: 'upsert', recordId }));
  const base = {
    id: recordId,
    digest: 'f'.repeat(64),
    proposal: {
      kind: 'row',
      input: { tool: 'rows.delete', tableId, expectedAppliedRevision: revision, recordId, expectedToken: token },
    },
    status: 'pending',
    outcome: null,
  };
  const view = draftViewSchema.parse(base);
  assert.equal(view.rowTable, null);
  assert.equal(view.rowCurrent, null);
  const labelled = draftViewSchema.parse({
    ...base,
    rowTable: {
      name: 'Notes',
      fields: [{ id: fieldId, label: 'Status', kind: 'single-select', options: [{ id: option, label: 'Open' }] }],
    },
    rowCurrent: { [fieldId]: { kind: 'single-select', optionId: option } },
  });
  assert.equal(labelled.rowTable?.fields[0]?.options?.[0]?.label, 'Open');
});
