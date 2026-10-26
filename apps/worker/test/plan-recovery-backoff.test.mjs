import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlanRecoveryBackoff } from '../src/plan-recovery-backoff.ts';

const minute = 60_000;

function clock() {
  let at = 0;
  return { now: () => at, advance: ms => (at += ms) };
}

test('a quiet plan whose version stays the same is woken after doubling intervals capped at an hour', () => {
  const time = clock();
  const backoff = createPlanRecoveryBackoff({ now: time.now });
  const plan = { id: 'plan', version: 3, quiet: true };
  const wakes = [];
  for (let pass = 0; pass <= 300; pass++) {
    if (backoff.due(plan)) wakes.push(pass);
    time.advance(minute);
  }
  assert.deepEqual(wakes, [0, 1, 3, 7, 15, 31, 63, 123, 183, 243]);
});

test('a version change or an open attempt wakes a plan at once and restarts its backoff', () => {
  const time = clock();
  const backoff = createPlanRecoveryBackoff({ now: time.now });
  assert.equal(backoff.due({ id: 'plan', version: 1, quiet: true }), true);
  time.advance(minute);
  assert.equal(backoff.due({ id: 'plan', version: 1, quiet: true }), true);
  time.advance(minute);
  assert.equal(backoff.due({ id: 'plan', version: 1, quiet: true }), false, 'backed off');
  assert.equal(backoff.due({ id: 'plan', version: 2, quiet: true }), true, 'a plan change wakes at once');
  assert.equal(backoff.due({ id: 'plan', version: 2, quiet: true }), false);
  assert.equal(backoff.due({ id: 'plan', version: 2, quiet: false }), true, 'open attempts are always recovered');
  assert.equal(backoff.due({ id: 'plan', version: 2, quiet: false }), true);
  assert.equal(backoff.due({ id: 'plan', version: 2, quiet: true }), true, 'backoff restarts once it is quiet again');
  assert.equal(backoff.due({ id: 'other', version: 2, quiet: true }), true, 'plans back off independently');
});

test('a planning plan whose owner turns end is woken at once so its next step can pause it', () => {
  const time = clock();
  const backoff = createPlanRecoveryBackoff({ now: time.now });
  assert.equal(backoff.due({ id: 'plan', version: 1, quiet: true, liveOwners: 1 }), true);
  time.advance(minute);
  assert.equal(backoff.due({ id: 'plan', version: 1, quiet: true, liveOwners: 1 }), true);
  time.advance(minute);
  assert.equal(backoff.due({ id: 'plan', version: 1, quiet: true, liveOwners: 1 }), false, 'backed off');
  assert.equal(backoff.due({ id: 'plan', version: 1, quiet: true, liveOwners: 0 }), true, 'the owner turn ended');
});
