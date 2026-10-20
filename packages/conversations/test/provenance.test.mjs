import assert from 'node:assert/strict';
import { test } from 'node:test';
import { provenanceSchema, sourceReferenceSchema } from '../src/provenance-contracts.ts';

test('provenance requires explicit knowledge and finite source predicates', () => {
  assert.deepEqual(provenanceSchema.parse({ kind: 'known', dependencies: [] }), { kind: 'known', dependencies: [] });
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  assert.deepEqual(sourceReferenceSchema.parse({ kind: 'schema-read', tableId: id.toUpperCase() }), {
    kind: 'schema-read',
    tableId: id,
  });
  assert.deepEqual(provenanceSchema.parse({ kind: 'legacy-unknown', originalReaders: [id], dependencies: [] }), {
    kind: 'legacy-unknown',
    originalReaders: [id],
    dependencies: [],
  });
  for (const value of [
    [],
    {},
    { dependencies: [] },
    { kind: 'known' },
    { kind: 'legacy-unknown', originalReaders: [], dependencies: [] },
  ])
    assert.throws(() => provenanceSchema.parse(value));
  for (const value of [
    { kind: 'table-read', tableId: id, permission: 'table.schema.manage' },
    { kind: 'integration-source', integrationId: id },
    { kind: 'project-revision', projectId: id },
    { kind: 'requester-only', userId: id },
    { kind: 'arbitrary', permission: 'public' },
  ])
    assert.throws(() => sourceReferenceSchema.parse(value));
});
