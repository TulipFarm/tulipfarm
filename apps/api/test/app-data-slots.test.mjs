import assert from 'node:assert/strict';
import { test } from 'node:test';
import { busy, createFairSlots } from '../src/app-data-slots.ts';

const settled = async promise => {
  let done = false;
  promise.then(() => (done = true));
  await new Promise(setImmediate);
  return done;
};

const stuck = () => {
  const ends = [];
  const work = () => new Promise(resolve => ends.push(() => resolve('done')));
  return { work, end: () => ends.shift()() };
};

test('while slots are stuck, timed-out waiters leave the queue and it holds at most its cap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slots = createFairSlots({ slots: 1, perKey: 1, waitMs: 100, queue: 3 });
  const held = stuck();
  const running = slots.run('a', held.work);
  for (let round = 1; round <= 3; round++) {
    const waiting = Array.from({ length: 3 }, () => slots.run('b', async () => 'served'));
    assert.equal(await settled(Promise.race(waiting)), false, `round ${round} waits for a slot`);
    const extra = slots.run('b', async () => 'served');
    assert.equal(await settled(extra), true, `round ${round} refuses a call past the cap at once`);
    assert.equal(await extra, busy);
    t.mock.timers.tick(100);
    assert.deepEqual(await Promise.all(waiting), [busy, busy, busy], `round ${round} times out`);
  }
  const next = slots.run('b', async () => 'served');
  held.end();
  assert.equal(await running, 'done');
  assert.equal(await next, 'served', 'the freed slot goes to the call still waiting');
});

test('a full queue still takes a call from another key, and that key gets a turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slots = createFairSlots({ slots: 1, perKey: 1, waitMs: 100, queue: 3 });
  const held = stuck();
  const running = slots.run('a', held.work);
  const flood = Array.from({ length: 3 }, () => slots.run('b', async () => 'b'));
  const theirs = slots.run('c', async () => 'c');
  assert.equal(await settled(theirs), false, 'the other key waits in the queue');
  assert.equal(await settled(flood[2]), true, "the flood's newest call gave up its place");
  held.end();
  assert.equal(await running, 'done');
  assert.deepEqual(await Promise.all([...flood, theirs]), ['b', 'b', busy, 'c']);
});
