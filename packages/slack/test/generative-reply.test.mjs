import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slackFormAnswers, slackPickedText } from '../src/generative-reply.ts';
import { requiredBotScopes } from '../src/contracts.ts';

test('picked values read as text', () => {
  assert.equal(slackPickedText({ selected_option: { text: { text: 'Region' }, value: 'region' } }), 'Region');
  assert.equal(slackPickedText({ selected_users: ['U1', 'U2'] }), '<@U1>, <@U2>');
  assert.equal(slackPickedText({ value: '  ' }), undefined);
});

test('form answers follow block order and name empty inputs', () => {
  const blocks = [
    { type: 'input', block_id: 'b', label: { text: 'Second' } },
    { type: 'section' },
    { type: 'input', block_id: 'a', label: { text: 'First' } },
  ];
  const values = { a: { x: { value: 'one' } }, b: { y: { value: null } } };
  assert.equal(slackFormAnswers(values, blocks), 'Second: (left empty)\nFirst: one');
});

test('generative UI asks for canvas and assistant scopes once', () => {
  const config = { scopeApproval: { botScopes: ['chat:write', 'canvases:write'] } };
  assert.deepEqual(requiredBotScopes(config, false, true), ['chat:write', 'canvases:write', 'assistant:write']);
  assert.deepEqual(requiredBotScopes(config, false), ['chat:write', 'canvases:write']);
});
