import assert from 'node:assert/strict';
import test from 'node:test';

import { modelName } from '../src/features/models/model-name.ts';

const families = [{ id: 'claude-plan-opus', displayName: 'Claude Opus 5.5' }];

test('a listed family shows its catalog name', () => {
  assert.equal(modelName(families, 'claude-plan-opus'), 'Claude Opus 5.5');
});

test('a plan model the catalog no longer lists shows the versioned name its ID carries', () => {
  assert.equal(modelName(families, 'copilot-claude-sonnet-4--6'), 'Claude Sonnet 4.6');
  assert.equal(modelName(undefined, 'chatgpt-gpt-6--1-sol'), 'GPT-6.1 Sol');
});

test('an unlisted family without a version in its ID shows the ID', () => {
  assert.equal(modelName(families, 'chatgpt-sol'), 'chatgpt-sol');
  assert.equal(modelName(families, 'retired-family'), 'retired-family');
});
