import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeGapSummary, knowledgePlaceLabel } from '../src/features/files/knowledge-labels.ts';

test('coverage gaps read as a short count of what Knowledge could not read', () => {
  assert.equal(knowledgeGapSummary(undefined), null);
  assert.equal(knowledgeGapSummary(null), null);
  assert.equal(knowledgeGapSummary({ count: 0, items: [] }), null);
  assert.equal(knowledgeGapSummary({ count: 1, items: [{ kind: 'image' }] }), '1 image couldn’t be read.');
  assert.equal(
    knowledgeGapSummary({ count: 3, items: [{ kind: 'image' }, { kind: 'image' }, { kind: 'image' }] }),
    '3 images couldn’t be read.',
  );
  assert.equal(
    knowledgeGapSummary({ count: 2, items: [{ kind: 'image' }, { kind: 'video' }] }),
    '2 parts couldn’t be read.',
  );
});

test('citation places start with a capital letter', () => {
  assert.equal(knowledgePlaceLabel('slide 4'), 'Slide 4');
  assert.equal(knowledgePlaceLabel("sheet 'Q1'"), "Sheet 'Q1'");
  assert.equal(knowledgePlaceLabel(undefined), '');
});
