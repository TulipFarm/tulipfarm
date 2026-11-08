import assert from 'node:assert/strict';
import { test } from 'node:test';
import { structureOnlyNote } from '../src/table-proposals.ts';

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
