import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskPauseReasonSchema, taskSummarySchema } from '@tulipfarm/agents/task-contracts';
import { taskNextStep, taskStatusLabel } from '../src/features/tasks/status.ts';

const id = '11111111-1111-4111-8111-111111111111';
const task = taskSummarySchema.parse({
  id,
  agentId: id,
  activationId: id,
  flowId: id,
  definitionRevision: 'a'.repeat(64),
  generation: 0,
  status: 'paused',
  parentTaskId: null,
  delegationDepth: 0,
  skills: [],
  scope: [],
  limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
  activeMilliseconds: '300000',
  toolCalls: 100,
  createdAt: '2026-10-11',
  cost: { chargedCreditUnits: '100000000000000', heldCreditUnits: '0' },
});

test('all pause reasons have distinct labels and recovery guidance', () => {
  const labels = new Set(),
    recoveries = new Set();
  for (const pauseReason of taskPauseReasonSchema.options) {
    labels.add(taskStatusLabel({ ...task, pauseReason }));
    recoveries.add(taskNextStep({ ...task, pauseReason }));
  }
  assert.equal(labels.size, taskPauseReasonSchema.options.length);
  assert.equal(recoveries.size, taskPauseReasonSchema.options.length);
});

test('legacy pauses stay neutral even when counters are exhausted', () => {
  for (const pauseReason of [null, undefined]) {
    assert.equal(taskStatusLabel({ ...task, pauseReason }), 'Paused');
    assert.doesNotMatch(taskNextStep({ ...task, pauseReason }), /limit/);
  }
  assert.equal(taskStatusLabel({ ...task, pauseReason: 'user' }), 'Paused by you');
});

test('credit admission explains the pause even below the cap and distinguishes workspace funds', () => {
  const creditPause = {
    ...task,
    pauseReason: 'limit.credits' as const,
    cost: { chargedCreditUnits: '99000000000000', heldCreditUnits: '0' },
  };
  assert.equal(taskStatusLabel(creditPause), 'Paused at the task credit limit');
  assert.match(taskNextStep(creditPause), /Raise the credit limit/);
  assert.match(taskNextStep({ ...task, pauseReason: 'limit.workspaceCredits' }), /admin to add credits/);
});

test('non-paused status ignores stale reasons and approval remains separate', () => {
  assert.equal(taskStatusLabel({ ...task, status: 'pending', pauseReason: 'user' }), 'Working');
  assert.equal(taskStatusLabel({ ...task, status: 'waiting-approval', pauseReason: null }), 'Needs your review');
  assert.match(taskNextStep({ ...task, status: 'waiting-approval' }), /unapproved batch/);
});
