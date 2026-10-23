import assert from 'node:assert/strict';
import test from 'node:test';

import { fallbackNote, replyFailure, replyRetrying } from '../src/features/chat/reply-failure-copy.ts';

const reasons = [
  'incomplete-response',
  'invalid-decision',
  'invalid-response',
  'output-limit',
  'configuration',
  'authentication',
  'permission',
  'rate-limit',
  'quota',
  'overload',
  'unavailable',
  'timeout',
  'transport',
  'refusal',
  'invalid-request',
  'context-overflow',
  'cancelled',
  'request-failed',
  'something-new',
];

test('every model failure gets short, specific copy with no provider details', () => {
  for (const reason of reasons) {
    const copy = replyFailure(`model-${reason}`);
    assert.ok(copy, reason);
    assert.ok(copy.length < 220, `${reason} copy stays short`);
    assert.doesNotMatch(copy, /model-|http|status|deployment|error code/i, reason);
  }
  assert.match(replyFailure('model-configuration')!, /^This model isn't available\./);
  assert.match(replyFailure('model-rate-limit')!, /^The model provider is busy\./);
  assert.match(replyFailure('model-quota')!, /Select another model/);
});

test('non-model and fallback codes are not reply failures', () => {
  assert.equal(replyFailure(null), null);
  assert.equal(replyFailure(undefined), null);
  assert.equal(replyFailure('transient-failure'), null);
  assert.equal(replyFailure('model-fallback:kimi'), null);
});

test('a queued reply after a model failure says it is retrying instead of spinning silently', () => {
  assert.equal(replyRetrying('queued', 'model-unavailable'), 'The model call failed. Retrying automatically…');
  assert.match(replyRetrying('queued', 'transient-failure')!, /Retrying automatically/);
  assert.equal(replyRetrying('queued', null), null);
  assert.equal(replyRetrying('processing', 'model-unavailable'), null);
  assert.equal(replyRetrying('queued', 'model-fallback:kimi'), null);
});

test('a completed reply answered by the fallback names the model that answered', () => {
  assert.equal(
    fallbackNote('completed', 'model-fallback:kimi'),
    'Answered by kimi because the chat model was unavailable.',
  );
  assert.equal(fallbackNote('completed', 'model-fallback:'), null);
  assert.equal(fallbackNote('failed', 'model-fallback:kimi'), null);
  assert.equal(fallbackNote('completed', null), null);
});
