import assert from 'node:assert/strict';
import { snapshot, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fuseKnowledgeCandidates } from '../dist/internal/search.js';

snapshot.setResolveSnapshotPath(() =>
  fileURLToPath(new URL('../../../reports/memory-core/ranking-fusion.snapshot.cjs', import.meta.url)),
);

const id = (value, prefix = '00000000') => `${prefix}-0000-4000-8000-${String(value).padStart(12, '0')}`;
const candidate = (document, ordinal = 0, extra = {}) => ({
  document_id: id(document),
  source_id: id(1, '30000000'),
  revision_id: id(document, '40000000'),
  publication_id: id(document, '10000000'),
  access_epoch: 1,
  ordinal,
  vector_publication_id: null,
  exact: false,
  ...extra,
});
const semantic = (document, ordinal = 0, extra = {}) =>
  candidate(document, ordinal, { vector_publication_id: id(document, '20000000'), ...extra });

test('lexical-only ranking keeps the highest-ranked passage per document', t => {
  t.assert.snapshot(fuseKnowledgeCandidates([candidate(3), candidate(1, 1), candidate(2), candidate(1)], []));
});

test('hybrid ranking preserves exact matches, merged flags, and vector identities', t => {
  t.assert.snapshot(
    fuseKnowledgeCandidates(
      [candidate(3, 0, { exact: true }), candidate(1, 1), candidate(2), candidate(1)],
      [semantic(1, 0, { broadened: true }), semantic(2), semantic(3)],
    ),
  );
});

test('equal fusion scores use document identity rather than list insertion order', t => {
  const result = fuseKnowledgeCandidates([candidate(2), candidate(1)], [semantic(1), semantic(2)]);
  assert.deepEqual(
    result.map(item => item.document_id),
    [id(1), id(2)],
  );
  t.assert.snapshot(result);
});

test('equal passage scores use ordinal and return each document once', t => {
  const result = fuseKnowledgeCandidates([candidate(1, 1), candidate(1)], [semantic(1), semantic(1, 1)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].ordinal, 0);
  t.assert.snapshot(result);
});

test('exact identifier matches outrank a higher fusion score from another passage', t => {
  t.assert.snapshot(
    fuseKnowledgeCandidates([candidate(2), candidate(1), candidate(1, 1, { exact: true })], [semantic(1), semantic(2)]),
  );
});

test('fusion retains the first 100 ranked documents at the candidate boundary', t => {
  const result = fuseKnowledgeCandidates(
    Array.from({ length: 110 }, (_, index) => candidate(index + 1)),
    [],
  );
  assert.equal(result.length, 100);
  t.assert.snapshot(result.map(item => item.document_id));
});
