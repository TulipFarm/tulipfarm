import assert from 'node:assert/strict';
import test from 'node:test';
import { actionEvidenceState } from '../dist/batch-contracts.js';

const candidate = { phase: 'ref-dispatch', commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), defaultBranch: 'main' };
const recovery = {
  ...candidate,
  provider: 'github',
  checkedAt: '2026-10-02T06:00:00Z',
  outcome: 'confirmed-original-success',
};
const action = (status, reconciliation, result = null) => ({ ordinal: 0, status, result, reconciliation });

test('preparatory evidence never establishes confirmed recovery, including direct success', () => {
  assert.equal(actionEvidenceState(action('unknown', candidate)), 'preparatory');
  assert.equal(actionEvidenceState(action('succeeded', candidate, { commitSha: candidate.commitSha })), 'preparatory');
  assert.equal(actionEvidenceState(action('rejected', candidate)), 'rejected');
});

test('confirmed recovery requires a succeeded receipt, result, and attributable provider evidence', () => {
  assert.equal(
    actionEvidenceState(action('succeeded', recovery, { commitSha: candidate.commitSha })),
    'confirmed-original-success',
  );
  assert.equal(actionEvidenceState(action('rejected', recovery)), 'rejected');
  assert.equal(actionEvidenceState(action('unknown', recovery)), 'unresolved');
  assert.equal(actionEvidenceState(action('succeeded', recovery)), null);
  assert.equal(actionEvidenceState(action('succeeded', { ...recovery, outcome: 'unresolved' }, {})), null);
  assert.equal(actionEvidenceState(action('succeeded', { outcome: 'confirmed-original-success' }, {})), null);
  assert.equal(actionEvidenceState(action('unknown', { ...recovery, outcome: 'unresolved' })), 'unresolved');
});

test('missing, unrecognized, and unattempted evidence makes no confirmation claim', () => {
  assert.equal(actionEvidenceState(undefined), null);
  assert.equal(actionEvidenceState(action('succeeded', null, {})), null);
  assert.equal(actionEvidenceState(action('succeeded', { arbitrary: true }, {})), null);
  assert.equal(actionEvidenceState(action('unattempted', recovery)), null);
});
