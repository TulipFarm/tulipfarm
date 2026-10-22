import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationResult, mergeSources } from '../src/results.ts';

test('legacy replies remain unknown and invalid structured results fail closed', () => {
  assert.deepEqual(conversationResult('Legacy answer'), { text: 'Legacy answer', sources: [{ kind: 'unknown' }] });
  assert.throws(() => conversationResult({ text: 'Forged', sources: [{ kind: 'public' }] }));
  assert.throws(() =>
    conversationResult({ text: 'Bad identifier', sources: [{ kind: 'table', tableId: 'anything' }] }),
  );
});

test('source merging deduplicates and collapses overflow to unknown rather than truncating protection', () => {
  const source = { kind: 'public-web', url: 'https://example.com/' };
  assert.deepEqual(mergeSources([source, source, { kind: 'unknown' }]), [source, { kind: 'unknown' }]);
  assert.deepEqual(
    mergeSources(Array.from({ length: 1001 }, (_, i) => ({ kind: 'public-web', url: `https://example.com/${i}` }))),
    [{ kind: 'unknown' }],
  );
});
