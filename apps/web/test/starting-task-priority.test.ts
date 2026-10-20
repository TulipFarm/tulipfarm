import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prioritizeTasks } from '../src/features/chat/starting-task-priority.ts';

test('Starter tasks show three primary choices and fold the rest (#1116)', () => {
  assert.deepEqual(prioritizeTasks([1, 2, 3, 4, 5]), { primary: [1, 2, 3], more: [4, 5] });
  assert.deepEqual(prioritizeTasks([1, 2, 3]), { primary: [1, 2, 3], more: [] });
  assert.deepEqual(prioritizeTasks([]), { primary: [], more: [] });
});
