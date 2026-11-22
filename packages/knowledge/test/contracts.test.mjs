import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parserProfileSchema } from '../dist/index.js';
import { knowledgeSaveSchema, knowledgeSearchSchema } from '../dist/contracts.js';

test('parser profiles preserve preparation identities and reject OCR', () => {
  const parser = { id: 'text-v1', engine: 'text', version: '1', normalization: 'markdown-v1', ocr: 'disabled' };
  assert.deepEqual(parserProfileSchema.parse(parser), parser);
  assert.equal(parserProfileSchema.safeParse({ ...parser, ocr: 'cloud' }).success, false);
});

test('browser-safe admission accepts only user content and rejects forged parser or original metadata', () => {
  const input = {
    commandId: '11111111-1111-4111-a111-111111111111',
    documentId: '22222222-2222-4222-a222-222222222222',
    expectedRevisionId: null,
    title: '  Handbook  ',
    input: { kind: 'note', text: '# Handbook\nCafé 🌳' },
  };
  assert.deepEqual(knowledgeSaveSchema.parse(input), { ...input, title: 'Handbook' });
  for (const extra of [{ parser: {} }, { original: { key: 'elsewhere' } }, { sources: [] }])
    assert.equal(knowledgeSaveSchema.safeParse({ ...input, ...extra }).success, false);
  for (const text of ['\ud800', 'hello\0world', '🌳'.repeat(2621441)])
    assert.equal(knowledgeSaveSchema.safeParse({ ...input, input: { kind: 'note', text } }).success, false);
  assert.equal(knowledgeSearchSchema.parse({ query: ' OPS-123 ' }).query, 'OPS-123');
  assert.equal(knowledgeSearchSchema.safeParse({ query: '\0' }).success, false);
});
