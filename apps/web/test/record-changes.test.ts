import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordChangesForTools, recordChangesSummary } from '../src/features/chat/record-changes.ts';

const revision = 'a'.repeat(40);
const tableA = '11111111-1111-4111-8111-111111111111',
  tableB = '22222222-2222-4222-8222-222222222222';
const [one, two, three] = [
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];
const change = (tableId: string, kind: 'created' | 'updated', recordIds: string[]) => ({
  status: 'completed',
  rowChange: { callId: crypto.randomUUID(), tableId, revision, kind, recordIds },
});

test('groups one reply’s completed writes per table and keeps a created-then-updated row as added', () => {
  const changes = recordChangesForTools('m1', [
    change(tableA, 'created', [one, two]),
    change(tableA, 'updated', [two, three]),
    change(tableB, 'updated', [one]),
    { status: 'failed', rowChange: change(tableA, 'created', [three]).rowChange },
    { status: 'completed' },
  ]);
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0], {
    id: `record-changes:m1:${tableA}:${revision}`,
    tableId: tableA,
    revision,
    created: [one, two],
    updated: [three],
  });
  assert.deepEqual(changes[1]?.updated, [one]);
  assert.equal(recordChangesSummary(changes[0]!), '2 rows added · 1 row updated');
  assert.equal(recordChangesSummary(changes[1]!), '1 row updated');
  assert.deepEqual(recordChangesForTools('m2', []), []);
});
