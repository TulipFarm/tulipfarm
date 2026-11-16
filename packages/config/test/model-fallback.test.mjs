import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelFallbackReason } from '../src/model-fallback.ts';

test('a failed call reason maps to the fallback reason the chat explains', () => {
  for (const [failure, reason] of [
    ['copilot-usage-limit', 'quota'],
    ['claude-usage-limit', 'quota'],
    ['quota', 'quota'],
    ['rate-limit', 'rate-limit'],
    ['timeout', 'timeout'],
    ['unavailable', 'outage'],
    ['overload', 'outage'],
    ['transport', 'outage'],
    ['claude-reconnect', 'sign-in'],
    ['authentication', 'sign-in'],
    ['copilot-not-eligible', 'model-unavailable'],
    ['configuration', 'model-unavailable'],
    ['permission', 'model-unavailable'],
  ])
    assert.equal(modelFallbackReason(failure), reason, failure);
});

test('a failure without a plain cause has no fallback reason', () => {
  for (const failure of [undefined, '', 'invalid-response', 'refusal', 'something-new'])
    assert.equal(modelFallbackReason(failure), undefined, String(failure));
});
