import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyChatLatency, mergeChatLatency } from '../src/latency.ts';

test('full workspace scans sum distributions and keep maximum ages without workspace labels', () => {
  const first = emptyChatLatency(),
    second = emptyChatLatency();
  first.durations[0].count = 1;
  first.durations[0].total = 10;
  first.durations[0].buckets.fill(1);
  first.oldest[0].seconds = 7;
  first.slow[0].at = 100;
  first.states[0].count = 1;
  first.attempts = 2;
  second.durations[0].count = 2;
  second.durations[0].total = 30;
  second.durations[0].buckets.fill(2);
  second.oldest[0].seconds = 5;
  second.slow[0].at = 200;
  second.states[0].count = 2;
  second.attempts = 3;
  mergeChatLatency(first, second);
  assert.equal(first.durations[0].count, 3);
  assert.equal(first.durations[0].total, 40);
  assert.deepEqual(first.durations[0].buckets, Array(10).fill(3));
  assert.equal(first.oldest[0].seconds, 7);
  assert.equal(first.slow[0].at, 200);
  assert.equal(first.states[0].count, 3);
  assert.equal(first.attempts, 5);
  assert.equal(emptyChatLatency().durations[0].count, 0, 'the next scan starts empty');
  assert.doesNotMatch(JSON.stringify(first), /workspace|conversation|turnId/);
});
