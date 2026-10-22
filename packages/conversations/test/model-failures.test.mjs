import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelFailureEndsTurn } from '../src/runtime.ts';

test('deterministic model failures end the turn instead of retrying', () => {
  for (const failure of [
    'model-configuration',
    'model-authentication',
    'model-permission',
    'model-quota',
    'model-invalid-request',
    'model-refusal',
    'model-incomplete-response',
  ])
    assert.equal(modelFailureEndsTurn(failure), true, failure);
});

test('transient model failures keep retrying', () => {
  for (const failure of [
    'model-rate-limit',
    'model-overload',
    'model-unavailable',
    'model-timeout',
    'model-transport',
    'model-provider-error',
    'not-a-model-failure',
  ])
    assert.equal(modelFailureEndsTurn(failure), false, failure);
});
