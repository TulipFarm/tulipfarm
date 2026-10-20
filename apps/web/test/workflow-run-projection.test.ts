import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  definitionSchema,
  runDetailSchema,
  runCondition,
  nextStep,
  type RunDetail,
  type Step,
} from '@tulipfarm/workflows/contracts';
import { workflowRunStates } from '../src/features/workflows/run-projection.ts';

const uuid = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-12T12:00:00Z';
const plain = (id: string): Step => ({ id, kind: 'transform', fields: {} });
const condition = (
  id: string,
  ifMet: string[],
  otherwise: string[],
  matched = true,
): Extract<Step, { kind: 'condition' }> => ({
  id,
  kind: 'condition',
  when: { left: { kind: 'literal', value: matched }, op: 'eq', right: { kind: 'literal', value: true } },
  ifMet,
  otherwise,
});
const receipt = (stepId: string, output: unknown = {}, status: 'completed' | 'waiting' = 'completed') => ({
  stepId,
  status,
  output,
  prompt: null,
  dueAt: null,
});
function detail(
  steps: Step[],
  status: RunDetail['run']['status'] = 'running',
  receipts: ReturnType<typeof receipt>[] = [],
): RunDetail {
  return runDetailSchema.parse({
    definition: definitionSchema.parse({ version: 1, name: 'Review', trigger: { kind: 'manual' }, steps }),
    actor: null,
    canManage: true,
    run: {
      id: uuid,
      workflowId: uuid,
      revision: uuid,
      status,
      source: 'manual',
      input: {},
      createdAt: at,
      startedAt: status === 'queued' || status === 'skipped' ? null : at,
      finishedAt: null,
      error: null,
      steps: receipts.map(item => ({ ...item, ordinal: steps.findIndex(step => step.id === item.stepId) })),
    },
  });
}

test('a run status never invents active, failed or completed steps', () => {
  const steps = [plain('first'), plain('last')];
  assert.deepEqual(workflowRunStates(detail(steps, 'queued')), {
    $trigger: 'pending',
    first: 'pending',
    last: 'pending',
  });
  assert.deepEqual(workflowRunStates(detail(steps)), { $trigger: 'completed', first: 'next', last: 'pending' });
  for (const status of ['completed', 'failed', 'blocked', 'cancelled', 'skipped'] as const) {
    const states = workflowRunStates(detail(steps, status));
    assert.equal(states.first, 'unknown', status);
    assert.equal(states.last, 'unknown', status);
    assert.equal(Object.values(states).includes('active'), false);
  }
  const waiting = workflowRunStates(detail(steps, 'waiting', [receipt('first', {}, 'waiting')]));
  assert.equal(waiting.first, 'waiting');
  assert.equal(waiting.last, 'pending');
});

test('next eligibility follows condition receipts, including reversed arrays and inherited gates', () => {
  const outer = condition('outer', ['end_yes', 'inner'], ['no']);
  const inner = condition('inner', ['nested_yes'], ['nested_no'], false);
  const steps = [
    outer,
    inner,
    plain('always'),
    plain('nested_yes'),
    plain('nested_no'),
    plain('no'),
    plain('end_yes'),
    plain('end'),
  ];
  const outputs = new Map<string, unknown>();
  const receipts: ReturnType<typeof receipt>[] = [];
  for (;;) {
    const next = nextStep(steps, outputs);
    const states = workflowRunStates(detail(steps, 'running', receipts));
    assert.deepEqual(
      Object.entries(states)
        .filter(([, value]) => value === 'next')
        .map(([id]) => id),
      next ? [next.step.id] : [],
    );
    if (!next) break;
    const output = next.step.kind === 'condition' ? runCondition(next.step, {}, outputs) : {};
    outputs.set(next.step.id, output);
    receipts.push(receipt(next.step.id, output));
  }
  const terminal = workflowRunStates(detail(steps, 'completed', receipts));
  assert.equal(terminal.no, 'skipped');
  assert.equal(terminal.nested_yes, 'skipped');
  assert.equal(terminal.nested_no, 'completed');
  assert.equal(terminal.end, 'completed');
});

test('skipped conditions inherit the outer choice without invented nested outcomes', () => {
  const outer = condition('outer', ['inner'], ['other'], false);
  const inner = condition('inner', ['child'], []);
  const source = detail([outer, inner, plain('child'), plain('other'), plain('join')], 'running', [
    receipt('outer', runCondition(outer, {}, new Map())),
  ]);
  assert.deepEqual(workflowRunStates(source), {
    $trigger: 'completed',
    outer: 'completed',
    inner: 'skipped',
    child: 'skipped',
    other: 'next',
    join: 'pending',
  });
});

test('withheld and malformed condition outputs never reveal a branch', () => {
  const check = condition('check', ['yes'], ['no']);
  const steps = [check, plain('yes'), plain('no'), plain('join')];
  for (const output of [
    null,
    { matched: true, ran: ['no'], skipped: ['yes'] },
    { matched: true, ran: [], skipped: [] },
    { withheld: 'source-access' },
  ]) {
    const states = workflowRunStates(detail(steps, 'running', [receipt('check', output)]));
    assert.equal(states.yes, 'pending');
    assert.equal(states.no, 'pending');
    assert.equal(Object.values(states).includes('skipped'), false);
    assert.equal(Object.values(states).includes('next'), false);
    if (output && 'withheld' in output) assert.equal(states.check, 'withheld');
  }
});

test('overlapping gates do not turn missing receipts into evidence', () => {
  const first = condition('first', ['shared'], []);
  const second = condition('second', ['shared'], [], false);
  const steps = [first, second, plain('shared'), plain('join')];
  const states = workflowRunStates(
    detail(steps, 'running', [
      receipt('first', runCondition(first, {}, new Map())),
      receipt('second', runCondition(second, {}, new Map())),
    ]),
  );
  assert.equal(states.shared, 'skipped');
  assert.equal(states.join, 'next');
  const missing = workflowRunStates(detail(steps, 'running', [receipt('second', runCondition(second, {}, new Map()))]));
  assert.equal(missing.first, 'next');
  assert.equal(missing.join, 'pending');
});
