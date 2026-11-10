import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Definition } from '@tulipfarm/workflows/contracts';
import {
  addCodeStep,
  codeSourceBytes,
  codeStepId,
  removeCodeStep,
  replaceCodeStep,
} from '../src/features/workflows/code-step-edits.ts';

type Step = Definition['steps'][number];
const code = (id: string, source = 'return input;'): Step => ({
  id,
  kind: 'code',
  language: 'python',
  source,
  input: { kind: 'input', path: [] },
});
const prepare: Step = { id: 'prepare', kind: 'transform', fields: {} };

test('new code step IDs skip ones already taken', () => {
  assert.equal(codeStepId(['prepare']), 'code');
  assert.equal(codeStepId(['code', 'code_2', 'code_4']), 'code_3');
});

test('source size counts the JSON-encoded bytes the server checks', () => {
  assert.equal(codeSourceBytes('ab'), 4);
  assert.equal(codeSourceBytes('a\nb'), 6);
  assert.equal(codeSourceBytes('é'), 4);
});

test('adding appends, editing replaces only the named code step, and removing drops it from branches', () => {
  assert.deepEqual(addCodeStep([prepare], code('score')), [prepare, code('score')]);
  assert.deepEqual(replaceCodeStep([prepare, code('score')], 'score', code('score', 'return 1')), [
    prepare,
    code('score', 'return 1'),
  ]);
  assert.deepEqual(replaceCodeStep([prepare], 'prepare', code('prepare')), [prepare], 'only code steps change');
  const check: Step = {
    id: 'check',
    kind: 'condition',
    when: { left: { kind: 'input', path: ['total'] }, op: 'gt', right: { kind: 'literal', value: 1 } },
    ifMet: ['score', 'finish'],
    otherwise: [],
  };
  const finish: Step = { id: 'finish', kind: 'transform', fields: {} };
  assert.deepEqual(removeCodeStep([check, code('score'), finish], 'score'), [{ ...check, ifMet: ['finish'] }, finish]);
  assert.deepEqual(removeCodeStep([prepare], 'missing'), [prepare]);
});
