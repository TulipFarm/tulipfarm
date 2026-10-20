import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Definition } from '@tulipfarm/workflows/contracts';
import { fieldPath, moveStep, removeStep, typedLiteral } from '../src/features/workflows/definition-edits.ts';

type Step = Definition['steps'][number];
const label = (step: Step, index: number) => `Step ${index + 1} (${step.id})`;
const prepare = (id: string, from?: string): Step => ({
  id,
  kind: 'transform',
  fields: { total: from ? { kind: 'step', step: from, path: ['total'] } : { kind: 'input', path: ['total'] } },
});
const check = (ifMet: string[], otherwise: string[] = []): Step => ({
  id: 'check',
  kind: 'condition',
  when: { left: { kind: 'input', path: ['total'] }, op: 'gt', right: { kind: 'literal', value: 100 } },
  ifMet,
  otherwise,
});

test('fixed values keep numbers and true or false typed, and everything else stays text', () => {
  assert.equal(typedLiteral('100'), 100);
  assert.equal(typedLiteral(' -2.5 '), -2.5);
  assert.equal(typedLiteral('1e3'), 1000);
  assert.equal(typedLiteral('true'), true);
  assert.equal(typedLiteral('false'), false);
  for (const text of ['', '007', '1.', '12abc', 'True', 'null', '"100"', 'Infinity'])
    assert.equal(typedLiteral(text), text);
});

test('field paths split on slashes and ignore spacing and empty parts', () => {
  assert.deepEqual(fieldPath('contract / start_date'), ['contract', 'start_date']);
  assert.deepEqual(fieldPath('contract /'), ['contract']);
  assert.deepEqual(fieldPath(''), []);
  assert.equal(fieldPath(Array.from({ length: 20 }, (_, n) => `p${n}`).join('/')).length, 16);
});

test('field paths retain literal dots, numeric indexes, and JSON-escaped slash keys', () => {
  assert.deepEqual(fieldPath('rows / 0 / due.date'), ['rows', '0', 'due.date']);
  assert.deepEqual(fieldPath('["rows","0","due/date"," spaced ",""]'), ['rows', '0', 'due/date', ' spaced ', '']);
});

test('removing a branch target clears it from the condition and says so', () => {
  const { steps, notice } = removeStep(
    [prepare('first'), check(['notify'], ['other']), prepare('notify'), prepare('other')],
    2,
    label,
  );
  assert.deepEqual(
    steps.map(step => step.id),
    ['first', 'check', 'other'],
  );
  assert.deepEqual(steps[1], check([], ['other']));
  assert.equal(notice, 'Step 2 (check) no longer controls steps that were removed or now come before it.');
});

test('removing a step that later steps read keeps the reference and asks for another source', () => {
  const { steps, notice } = removeStep(
    [prepare('first'), prepare('second', 'first'), prepare('third', 'first')],
    0,
    label,
  );
  assert.deepEqual(steps, [prepare('second', 'first'), prepare('third', 'first')]);
  assert.equal(
    notice,
    'Step 1 (second) and Step 2 (third) read the output of a removed or later step. Choose another source before saving.',
  );
});

test('moving a condition after its target drops that branch, and moving a reader before its source is named', () => {
  const below = moveStep([check(['notify']), prepare('notify')], 0, 1, label);
  assert.deepEqual(below.steps, [prepare('notify'), check([])]);
  assert.equal(below.notice, 'Step 2 (check) no longer controls steps that were removed or now come before it.');
  const early = moveStep([prepare('first'), prepare('second', 'first')], 1, -1, label);
  assert.equal(
    early.notice,
    'Step 1 (second) reads the output of a removed or later step. Choose another source before saving.',
  );
});

test('an arrangement that keeps every branch and reference valid has no notice', () => {
  assert.equal(removeStep([prepare('first'), check(['notify']), prepare('notify')], 0, label).notice, null);
  assert.equal(moveStep([check(['a', 'b']), prepare('a'), prepare('b')], 1, 1, label).notice, null);
});
