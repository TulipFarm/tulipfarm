import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  knowledgeBudgetSchema,
  reserveKnowledgeOperation,
  knowledgeBudgetMetadata,
  knowledgeEpisodeCitationLimit,
} from '../src/knowledge-retrieval.ts';

const fresh = () => knowledgeBudgetSchema.parse({ version: 1, operations: [] });
const settle = (state, status = 'completed') => {
  state.operations.at(-1).status = status;
  return state;
};
const reserve = (state, id, count = 1, grouped = false, initial = true) =>
  reserveKnowledgeOperation(state, id, { query: id }, count, grouped, initial);

test('one initial operation and only two grouped expansion rounds', () => {
  let state = settle(reserve(fresh(), 'initial', 1, true));
  state = settle(reserve(state, 'deep', 3, true, false));
  state = settle(reserve(state, 'gap', 3, true, false));
  assert.deepEqual(knowledgeBudgetMetadata(state), {
    initialRemaining: 0,
    deepRemaining: 0,
    gapRemaining: 0,
    stop: true,
  });
  assert.throws(() => reserve(state, 'fourth', 1, true, false), { code: 'knowledge-budget-exhausted' });
});

test('legacy first read consumes initial slot and tool switching never resets it', () => {
  let state = settle(reserve(fresh(), 'read-citation'));
  for (let index = 0; index < 6; index++) state = settle(reserve(state, `legacy-${index}`));
  assert.deepEqual(
    state.operations.map(operation => operation.phase),
    ['initial', 'deep', 'deep', 'deep', 'gap', 'gap', 'gap'],
  );
  assert.throws(() => reserve(state, 'new-query'), { code: 'knowledge-budget-exhausted' });
  assert.throws(() => reserve(state, 'grouped-search', 1, true), { code: 'knowledge-budget-exhausted' });
});

test('parallel rounds wait for settlement; failed work remains spent', () => {
  const initial = reserve(fresh(), 'initial');
  assert.throws(() => reserve(initial, 'deep', 3, true, false), { code: 'knowledge-round-pending' });
  const deep = reserve(settle(initial, 'failed'), 'deep', 3, true, false);
  assert.throws(() => reserve(deep, 'gap', 3, true, false), { code: 'knowledge-round-pending' });
  const gap = reserve(settle(deep, 'failed'), 'gap', 3, true, false);
  assert.equal(knowledgeBudgetMetadata(settle(gap, 'failed')).stop, true);
});

test('duplicate identities, changed payloads, and semantic retries never add slots', () => {
  const state = settle(reserve(fresh(), 'original'));
  assert.throws(() => reserve(state, 'original'), { code: 'knowledge-operation-spent' });
  assert.throws(() => reserveKnowledgeOperation(state, 'original', { query: 'changed' }, 1, false, true), {
    code: 'knowledge-operation-conflict',
  });
  assert.throws(() => reserveKnowledgeOperation(state, 'new-transport-id', { query: 'original' }, 1, false, true), {
    code: 'knowledge-operation-spent',
  });
  assert.equal(state.operations.length, 1);
});

test('branch and phase admission is atomic and refuses oversized rounds', () => {
  const state = settle(reserve(fresh(), 'initial'));
  for (const count of [0, 4, 100, 1.5])
    assert.throws(() => reserve(state, 'oversized', count, true, false), { code: 'knowledge-budget-exhausted' });
  assert.equal(state.operations.length, 1);
  assert.throws(() => reserve(fresh(), 'expand-first', 1, true, false), { code: 'knowledge-budget-exhausted' });
});

test('dedup references retain the entire derived 1024-passage episode without text copies', () => {
  assert.equal(knowledgeEpisodeCitationLimit, 1024);
  const citations = Array.from({ length: 1024 }, (_, index) => `00000000-0000-4000-8000-000000000000:${index}`);
  const state = knowledgeBudgetSchema.parse({ ...fresh(), completeCitationIds: citations });
  const reserved = reserve(state, 'initial');
  assert.deepEqual(reserved.completeCitationIds, citations);
  assert.ok(Buffer.byteLength(JSON.stringify(reserved)) < 65536);
  assert.equal(
    knowledgeBudgetSchema.safeParse({ ...state, completeCitationIds: [...citations, 'extra'] }).success,
    false,
  );
});
