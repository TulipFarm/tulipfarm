import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedAccessProof,
  currentAccessProof,
  InvalidAccessDecision,
  requireAccess,
} from '../dist/ports/authorizer.js';

test('core consumes explicit decisions from an in-memory authorizer without a host transaction', async () => {
  const records = new Map([['visible', { epoch: 2, text: 'evidence' }]]);
  const denied = new Error('denied');
  const authorizer = {
    async decide(_check, id) {
      return records.has(id) ? { kind: 'allowed', value: records.get(id) } : { kind: 'denied', error: denied };
    },
  };
  assert.deepEqual(requireAccess(await authorizer.decide('document', 'visible')), { epoch: 2, text: 'evidence' });
  assert.throws(
    () => requireAccess({ kind: 'denied', error: denied }),
    error => error === denied,
  );
  await assert.rejects(
    async () => requireAccess(await authorizer.decide('document', 'hidden')),
    error => error === denied,
  );
  records.delete('visible');
  await assert.rejects(
    async () => requireAccess(await authorizer.decide('document', 'visible')),
    error => error === denied,
  );
});

test('missing or malformed access decisions fail closed and explicit void checks remain usable', () => {
  for (const decision of [
    undefined,
    null,
    {},
    true,
    { kind: 'allowed' },
    { kind: 'denied' },
    { kind: 'denied', error: 'no' },
  ])
    assert.throws(() => requireAccess(decision), InvalidAccessDecision);
  assert.equal(requireAccess({ kind: 'allowed', value: undefined }), undefined);
});

const at = milliseconds => new Date(milliseconds);
const proof = (acl, principal, expires) => ({
  aclCheckedAt: at(acl),
  principalCheckedAt: at(principal),
  expiresAt: at(expires),
});

test('proof age preserves both check times and the exact five-minute upper bound', () => {
  assert.equal(boundedAccessProof(proof(1_000, 2_000, 301_000), 300_000), true);
  assert.equal(boundedAccessProof(proof(1_000, 2_000, 301_001), 300_000), false);
  assert.equal(boundedAccessProof(proof(2_000, 1_000, 301_000), 300_000), true);
  assert.equal(boundedAccessProof(proof(1_000, 2_000, 2_000), 300_000), false);
  assert.equal(boundedAccessProof(proof(1_000, 2_000, 2_001), 300_000), true);
  assert.equal(boundedAccessProof(proof(NaN, 2_000, 3_000), 300_000), false);
});

test('current proof rejects either future check and exact expiry, without rounding or extra age checks', () => {
  assert.equal(currentAccessProof(proof(1_000, 2_000, 3_000), at(2_000)), true);
  assert.equal(currentAccessProof(proof(2_001, 2_000, 3_000), at(2_000)), false);
  assert.equal(currentAccessProof(proof(1_000, 2_001, 3_000), at(2_000)), false);
  assert.equal(currentAccessProof(proof(1_000, 2_000, 3_000), at(3_000)), false);
  assert.equal(currentAccessProof(proof(1_000, 2_000, 3_000), at(2_999)), true);
  assert.equal(currentAccessProof(proof(1_000, 2_000, 3_000), at(NaN)), false);
  assert.equal(currentAccessProof(proof(NaN, 2_000, 3_000), at(2_000)), false);
});
