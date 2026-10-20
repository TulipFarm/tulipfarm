import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceHasSuccessfulOutcome } from '../src/plan-evidence.ts';

test('a completed receipt is not success when its actual result is denied, pending, unknown or only a draft', () => {
  for (const output of [
    null,
    'Everything is done.',
    { error: 'access-denied' },
    { status: 'pending' },
    { status: 'unknown' },
    { state: 'failed' },
    { kind: 'draft' },
    { available: false },
    { success: false },
    { ok: false },
    { actions: [{ status: 'failed' }] },
  ])
    assert.equal(evidenceHasSuccessfulOutcome('agents.status', output), false, JSON.stringify(output));
  for (const tool of [
    'agents.draft',
    'tables.propose',
    'plans.create',
    'plans.read',
    'plans.update',
    'present.choice',
  ]) {
    assert.equal(evidenceHasSuccessfulOutcome(tool, { status: 'completed' }), false, tool);
  }
  assert.equal(evidenceHasSuccessfulOutcome('agents.status', { status: 'completed', agentId: 'observed-agent' }), true);
  assert.equal(evidenceHasSuccessfulOutcome('slack.resolve', { available: true, channel: 'C_EXAMPLE' }), true);
});
