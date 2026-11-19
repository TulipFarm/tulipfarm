import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { QueryKey } from '@tanstack/react-query';

const source = new URL('../src/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/auth')
      return { url: 'data:text/javascript,export const apiOrigin = "http://panels.test";', shortCircuit: true };
    if (specifier.startsWith('@/')) return next(new URL(`${specifier.slice(2)}.ts`, source).href, context);
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { persistedPanelReads } = await import('../src/features/navigation/persisted-panels.ts');
hooks.deregister();

const id = '10000000-0000-4000-8000-000000000001';
const saved = (key: QueryKey) => persistedPanelReads.find(read => read.match(key))?.name ?? null;

test('first pages of panels persist; later pages, filters and cursors stay memory-only', () => {
  const runs = (filters: object) => ['workflows', 'detail', id, 'runs', filters];
  assert.equal(saved(runs({ status: null, triggerId: null, pages: 1 })), 'workflow-runs');
  assert.equal(saved(runs({ status: null, triggerId: null, pages: 2 })), null);
  assert.equal(saved(runs({ status: 'failed', triggerId: null, pages: 1 })), null);
  assert.equal(saved(['tasks', 'detail', id, 'history', { after: -1 }]), 'task-history');
  assert.equal(saved(['tasks', 'detail', id, 'history', { after: 40 }]), null);
  assert.equal(saved(['tasks', 'detail', id, 'proposals', 'list', { after: null }]), 'task-proposals');
  assert.equal(saved(['tasks', 'detail', id, 'proposals', 'list', { after: 'cursor' }]), null);
  assert.equal(saved(['skills', id, 'history', 'revision', 0]), 'skill-history');
  assert.equal(saved(['skills', id, 'history', 'revision', 20]), null);
  assert.equal(saved(['models', 'membership']), null);
  assert.equal(saved(['models', 'subscriptions', 'extra']), null);
});

test('a chat plan and its plan list are told apart, and each revision document is its own read', () => {
  const plans = ['conversations', 'detail', id, 'plans'];
  assert.equal(saved([...plans, 'list']), 'chat-plans');
  assert.equal(saved([...plans, id]), 'chat-plan');
  assert.equal(saved([...plans, id, 'document', 3]), 'chat-plan-document');
});

test('a run history holding more than one page is not saved, even under the first-page key', () => {
  const read = persistedPanelReads.find(item => item.name === 'workflow-runs');
  const page = { runs: [], nextCursor: null };
  assert.equal(read?.schema.safeParse({ pages: [page], runs: [], nextCursor: null }).success, true);
  assert.equal(read?.schema.safeParse({ pages: [page, page], runs: [], nextCursor: null }).success, false);
});
