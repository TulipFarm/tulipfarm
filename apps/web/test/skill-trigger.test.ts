import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillAt } from '../src/features/chat/skill-trigger.ts';

test('reads the skill query between a slash and the caret', () => {
  assert.deepEqual(skillAt('/', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(skillAt('Use /qual', 9), { start: 4, end: 9, query: 'qual' });
  assert.deepEqual(skillAt('/qualify lead', 13), { start: 0, end: 13, query: 'qualify lead' });
  assert.deepEqual(skillAt('/ab', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(skillAt('line\n/q', 7), { start: 5, end: 7, query: 'q' });
});

test('ignores a spaced slash, a slash inside a link, and a query with @', () => {
  assert.deepEqual(skillAt('1 / 2', 5), null);
  assert.deepEqual(skillAt('see http://x', 12), null);
  assert.deepEqual(skillAt('/a@b', 4), null);
});
