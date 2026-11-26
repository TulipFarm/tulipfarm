import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { QueryKey } from '@tanstack/react-query';

const source = new URL('../src/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/auth')
      return { url: 'data:text/javascript,export const apiOrigin = "http://lists.test";', shortCircuit: true };
    if (specifier.startsWith('@/')) return next(new URL(`${specifier.slice(2)}.ts`, source).href, context);
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { persistedListReads } = await import('../src/features/navigation/persisted-lists.ts');
hooks.deregister();

const id = '10000000-0000-4000-8000-000000000001';
const saved = (key: QueryKey) => persistedListReads.find(read => read.match(key))?.name ?? null;

test('the Tasks board reads persist so a reload shows the last board, and other table reads do not', () => {
  assert.equal(saved(['tasks-table', id]), 'tasks-table');
  assert.equal(saved(['tables', 'detail', id, 'records', 'task-board', 'revision-1']), 'task-board-rows');
  assert.equal(saved(['task-board', 'activity', id]), 'task-activity');
  assert.equal(saved(['tasks', 'keys', id]), 'task-keys');
  assert.equal(saved(['tables', 'detail', id, 'records', 'query', {}]), null);
  assert.equal(saved(['tasks', 'keys', id, 'extra']), null);
});

test('a saved board read holds rows and the more flag, and anything else is refused', () => {
  const rows = persistedListReads.find(read => read.name === 'task-board-rows');
  const record = { id, token: id, values: {} };
  assert.equal(rows?.schema.safeParse({ records: [record], more: false }).success, true);
  assert.equal(rows?.schema.safeParse({ records: [record] }).success, false);
});
