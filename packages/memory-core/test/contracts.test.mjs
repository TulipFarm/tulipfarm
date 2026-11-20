import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../dist/index.js';

test('Knowledge request defaults and Unicode checks are unchanged', () => {
  assert.deepEqual(core.knowledgeSearchRequestSchema.parse({ kind: 'typing', query: '  records  ' }), {
    kind: 'typing',
    query: 'records',
    filters: {
      kinds: ['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation'],
      sourceIds: [],
      documentIds: [],
    },
  });
  for (const query of ['', '\0', '\ud800', '\udc00']) {
    assert.equal(core.knowledgeSearchSchema.safeParse({ query }).success, false);
  }
  assert.equal(core.knowledgeSearchSchema.safeParse({ query: '\ud83c\udf37' }).success, true);
  assert.equal(core.knowledgeSearchSchema.safeParse({ query: 'records', extra: true }).success, false);
});

test('personal memory keeps its character, Unicode, and revision limits', () => {
  const valid = { content: '\ud83c\udf37'.repeat(10000), expectedRevision: 2147483646 };
  assert.deepEqual(core.savePersonalMemorySchema.parse(valid), valid);
  for (const content of ['a'.repeat(10001), '\0', '\ud800', '\udc00']) {
    assert.equal(core.savePersonalMemorySchema.safeParse({ content, expectedRevision: 0 }).success, false);
  }
  assert.equal(core.savePersonalMemorySchema.safeParse({ content: '', expectedRevision: 2147483647 }).success, false);
  assert.equal(core.personalMemorySchema.safeParse({ content: '', revision: 2147483647 }).success, true);
});

test('compaction commands keep a strict shape', () => {
  const command = { kind: 'compact', prompt: null, compactionId: null };
  assert.deepEqual(core.compactCommandPartSchema.parse(command), command);
  assert.equal(core.compactCommandPartSchema.safeParse({ ...command, extra: true }).success, false);
});
