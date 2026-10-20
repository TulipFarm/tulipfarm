import assert from 'node:assert/strict';
import { test } from 'node:test';
import { embeddingProfileSchema, parserProfileSchema, knowledgeLimits, providerCoverage } from '../dist/index.js';
import { knowledgeSaveSchema, knowledgeSearchSchema } from '../dist/contracts.js';

test('profiles preserve preparation identities and reject OCR or mixed dimensions', () => {
  const parser = { id: 'text-v1', engine: 'text', version: '1', normalization: 'markdown-v1', ocr: 'disabled' };
  assert.deepEqual(parserProfileSchema.parse(parser), parser);
  assert.equal(parserProfileSchema.safeParse({ ...parser, ocr: 'cloud' }).success, false);
  const profile = {
    id: 'azure-large-1536-v1',
    model: 'text-embedding-3-large',
    deployment: 'deployment-to-qualify',
    dimensions: 1536,
    tokenizer: 'cl100k_base',
    preparation: 'headings-v1',
  };
  assert.deepEqual(embeddingProfileSchema.parse(profile), profile);
  assert.equal(embeddingProfileSchema.safeParse({ ...profile, dimensions: 2048 }).success, false);
  assert.equal(embeddingProfileSchema.safeParse({ ...profile, preparation: '' }).success, false);
});

test('provider coverage blocks unqualified connected sources and limits are finite', () => {
  assert.deepEqual(Object.keys(providerCoverage), [
    'conversation',
    'note',
    'file',
    'google',
    'slack',
    'github',
    'confluence',
    'jira',
  ]);
  for (const provider of ['google', 'slack', 'github', 'confluence', 'jira'])
    assert.equal(providerCoverage[provider].status, 'adapter-required');
  assert.equal(knowledgeLimits.permissionAgeMs, 300000);
  assert.equal(knowledgeLimits.retentionDays, 30);
  assert.equal(knowledgeLimits.originalBytes, 10485760);
  assert.equal(knowledgeLimits.documents, 10000);
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
