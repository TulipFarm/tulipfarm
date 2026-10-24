import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillTasks, prioritizeTasks } from '../src/features/chat/starting-task-priority.ts';

test('A short saved task list is topped up to three with general prompts, without duplicates', () => {
  const task = (id: string, label = id) => ({ id, label });
  const general = ['a', 'b', 'c', 'd'].map(id => task(id));
  assert.deepEqual(fillTasks([task('x')], general), [task('x'), task('a'), task('b')]);
  assert.deepEqual(fillTasks([task('b')], general), [task('b'), task('a'), task('c')]);
  assert.deepEqual(fillTasks([task('saved-a', 'a')], general), [task('saved-a', 'a'), task('b'), task('c')]);
  assert.deepEqual(fillTasks([], general), [task('a'), task('b'), task('c')]);
  const saved = ['w', 'x', 'y', 'z'].map(id => task(id));
  assert.deepEqual(fillTasks(saved, general), saved);
});

test('Starter tasks show three primary choices and fold the rest (#1116)', () => {
  assert.deepEqual(prioritizeTasks([1, 2, 3, 4, 5]), { primary: [1, 2, 3], more: [4, 5] });
  assert.deepEqual(prioritizeTasks([1, 2, 3]), { primary: [1, 2, 3], more: [] });
  assert.deepEqual(prioritizeTasks([]), { primary: [], more: [] });
});
