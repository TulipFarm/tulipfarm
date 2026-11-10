import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountConnectionState, slackConnectionState } from '../src/features/integrations/connection-state.ts';

test('unfinished and cancelled first consent is neutral, including saved failed attempts', () => {
  for (const state of ['authorizing', 'reconnect-required'])
    assert.equal(accountConnectionState({ state, identity: null }), 'pending');
  assert.equal(accountConnectionState({ state: 'disconnected', identity: null }), 'disconnected');
  for (const state of ['reserved', 'authorizing', 'failed', 'revoked'])
    assert.equal(slackConnectionState({ state, scopes: [] }), 'pending');
});

test('cancelled reconnects of established accounts still need repair', () => {
  for (const state of ['authorizing', 'reconnect-required'])
    assert.equal(accountConnectionState({ state, identity: { id: 'existing' } }), 'attention');
  for (const state of ['reserved', 'authorizing', 'failed', 'revoked', 'permissions-required', 'reconnect-required'])
    assert.equal(slackConnectionState({ state, scopes: ['chat:write'] }), 'attention');
  assert.equal(accountConnectionState({ state: 'active', identity: { id: 'existing' } }), 'connected');
  assert.equal(accountConnectionState({ state: 'refreshing', identity: { id: 'existing' } }), 'refreshing');
  assert.equal(accountConnectionState({ state: 'disconnected', identity: { id: 'existing' } }), 'disconnected');
});
