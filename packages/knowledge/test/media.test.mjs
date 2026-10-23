import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeLocationOf, knowledgeLocationText } from '../dist/index.js';
import { KnowledgeParseError } from '../dist/parser.js';
import { publicationSeed, recognitionFailed } from '../dist/internal/media.js';

test('passage locations read as page, slide or sheet and whole-passage offsets have none', () => {
  assert.equal(knowledgeLocationText(knowledgeLocationOf({ kind: 'page', page: 4 })), 'page 4');
  assert.equal(knowledgeLocationText(knowledgeLocationOf({ kind: 'slide', slide: 7 })), 'slide 7');
  assert.equal(knowledgeLocationText(knowledgeLocationOf({ kind: 'sheet', sheet: 2, name: 'Q1' })), "sheet 'Q1'");
  assert.equal(knowledgeLocationText(knowledgeLocationOf({ kind: 'sheet', sheet: 2, name: '' })), 'sheet 2');
  assert.equal(knowledgeLocationOf({ start: 0, end: 10 }), undefined);
  assert.equal(knowledgeLocationText(undefined), undefined);
});

test('a text-only parse keeps its publication id and a vision parse or gaps make a new one', () => {
  const text = { id: 'text-v1', engine: 'text', version: '1', normalization: 'markdown-v1', ocr: 'disabled' };
  const parsed = { markdown: '# A', chunks: [], profile: text, gaps: [] };
  const revision = '00000000-0000-4000-8000-000000000001';
  assert.equal(publicationSeed('google-', revision, parsed), `google-publication:${revision}`);
  const gap = { kind: 'image', reason: 'recognition-unavailable', label: 'Image', location: { kind: 'page', page: 2 } };
  const gapped = publicationSeed('', revision, { ...parsed, gaps: [gap] });
  const vision = publicationSeed('', revision, {
    ...parsed,
    profile: { ...text, id: 'text-v1-vision-m-p1', ocr: 'vision', ocrModel: 'm', ocrPrompt: 'p1' },
  });
  const nextPrompt = publicationSeed('', revision, {
    ...parsed,
    profile: { ...text, id: 'text-v1-vision-m-p2', ocr: 'vision', ocrModel: 'm', ocrPrompt: 'p2' },
  });
  assert.equal(new Set([`publication:${revision}`, gapped, vision, nextPrompt]).size, 4);
  assert.equal(publicationSeed('', revision, { ...parsed, gaps: [gap] }), gapped);
});

test('only retryable recognition failures are retried like provider failures', () => {
  assert.equal(recognitionFailed(new KnowledgeParseError('resource-limited', { reason: 'recognition-failed' })), true);
  assert.equal(recognitionFailed(new KnowledgeParseError('resource-limited')), false);
  assert.equal(recognitionFailed(new Error('recognition-failed')), false);
});
