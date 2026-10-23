import assert from 'node:assert/strict';
import { test } from 'node:test';
import { variantStateSchema } from '../dist/contracts.js';
import { canTransition, finalVariantStates, variantTransitions } from '../dist/variant-states.js';

const states = variantStateSchema.options;
const nonFinal = ['draft', 'awaiting-approval', 'scheduled', 'sending', 'processing', 'blocked', 'outcome-unknown'];
// FORMAT "Variant states", row by row: [from, to, condition].
const format = [
  ['draft', 'awaiting-approval'],
  ['awaiting-approval', 'scheduled'],
  ['awaiting-approval', 'cancelled'],
  ['scheduled', 'sending'],
  ['scheduled', 'blocked'],
  ['sending', 'processing'],
  ['processing', 'sending'],
  ['processing', 'blocked'],
  ['sending', 'published'],
  ['processing', 'published'],
  ['sending', 'failed'],
  ['processing', 'failed'],
  ['sending', 'outcome-unknown'],
  ['processing', 'outcome-unknown'],
  ['outcome-unknown', 'published'],
  ['outcome-unknown', 'not-published'],
  ['blocked', 'scheduled', 'no-receipt'],
  ['blocked', 'processing', 'receipt'],
  ['blocked', 'cancelled'],
  // TECH "Revisions": a new revision copies only these states, and only without an attempted step.
  ...['draft', 'awaiting-approval', 'scheduled', 'blocked'].map(from => [from, 'superseded', 'no-receipt']),
  ...nonFinal.map(from => [from, 'cancelled', 'no-receipt']),
];

test('final states are the five FORMAT lists', () => {
  assert.deepEqual([...finalVariantStates].sort(), ['cancelled', 'failed', 'not-published', 'published', 'superseded']);
  assert.deepEqual([...states].filter(state => !finalVariantStates.has(state)).sort(), [...nonFinal].sort());
});

test('the transition table is exactly the FORMAT table', () => {
  const key = ([from, to, requires]) => `${from}>${to}>${requires ?? ''}`;
  const actual = variantTransitions.map(({ from, to, requires }) => key([from, to, requires])).sort();
  assert.deepEqual(actual, format.map(key).sort());
  for (const transition of variantTransitions) assert.ok(transition.when.length > 0);
});

test('every listed transition is allowed under its condition', () => {
  for (const [from, to, requires] of format) {
    const hasReceipt = requires === 'receipt';
    assert.ok(canTransition(from, to, { hasReceipt }), `${from} -> ${to}`);
  }
});

test('receipt-gated transitions follow whether a step was attempted', () => {
  assert.equal(canTransition('blocked', 'scheduled', { hasReceipt: true }), false);
  assert.equal(canTransition('blocked', 'processing', { hasReceipt: false }), false);
  for (const from of ['draft', 'scheduled', 'sending', 'processing', 'blocked'])
    assert.equal(canTransition(from, 'superseded', { hasReceipt: true }), false, from);
  for (const from of ['sending', 'processing', 'outcome-unknown', 'scheduled'])
    assert.equal(canTransition(from, 'cancelled', { hasReceipt: true }), false, from);
  assert.ok(canTransition('blocked', 'cancelled', { hasReceipt: true }));
  assert.ok(canTransition('awaiting-approval', 'cancelled', { hasReceipt: true }));
  for (const from of ['sending', 'processing', 'outcome-unknown'])
    for (const hasReceipt of [false, true])
      assert.equal(canTransition(from, 'superseded', { hasReceipt }), false, from);
});

test('a blocked variant resumes to scheduled before any step, and to processing after one', () => {
  const resume = variantTransitions.filter(
    transition => transition.from === 'blocked' && ['scheduled', 'processing'].includes(transition.to),
  );
  assert.deepEqual(resume.map(({ to, requires }) => [to, requires]).sort(), [
    ['processing', 'receipt'],
    ['scheduled', 'no-receipt'],
  ]);
  for (const transition of resume) assert.match(transition.when, /recheckAt passes/);
  for (const transition of resume) assert.match(transition.when, /resume reruns every check/);
  assert.ok(canTransition('blocked', 'processing', { hasReceipt: true }));
  assert.ok(canTransition('blocked', 'scheduled', { hasReceipt: false }));
});

test('unlisted transitions are refused, and nothing leaves a final state', () => {
  const listed = new Set(format.map(([from, to]) => `${from}>${to}`));
  let refused = 0;
  for (const from of states)
    for (const to of states) {
      if (listed.has(`${from}>${to}`)) continue;
      for (const hasReceipt of [false, true])
        assert.equal(canTransition(from, to, { hasReceipt }), false, `${from}>${to}`);
      refused += 1;
    }
  assert.ok(refused > 100);
  for (const from of finalVariantStates)
    for (const to of states) assert.equal(canTransition(from, to, { hasReceipt: false }), false);
  for (const [from, to] of [
    ['draft', 'scheduled'],
    ['scheduled', 'published'],
    ['outcome-unknown', 'sending'],
    ['outcome-unknown', 'superseded'],
    ['failed', 'scheduled'],
  ])
    assert.equal(canTransition(from, to, { hasReceipt: false }), false, `${from}>${to}`);
});
