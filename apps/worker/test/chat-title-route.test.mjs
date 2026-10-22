import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatTitleRoute } from '../src/conversation-activities.ts';

test('chat titles default to the priced Claude Haiku route with a small output limit', () => {
  assert.deepEqual(
    chatTitleRoute({ MODEL_FAMILIES: 'claude-haiku,claude-sonnet', ANTHROPIC_API_KEY: 'synthetic-key' }),
    {
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/',
      model: 'claude-haiku-4-5',
      apiKey: 'synthetic-key',
      timeoutMs: 45000,
      maxOutputTokens: 256,
    },
  );
});

test('chat titles use the chat route when the title family has no route', () => {
  assert.equal(chatTitleRoute({}), undefined);
  assert.equal(
    chatTitleRoute({ ANTHROPIC_API_KEY: 'synthetic-key', CHAT_TITLE_MODEL_FAMILY: 'unknown-family' }),
    undefined,
  );
  assert.equal(chatTitleRoute({ ANTHROPIC_API_KEY: 'synthetic-key', CHAT_TITLE_MODEL_FAMILY: 'gpt-sol' }), undefined);
  assert.equal(
    chatTitleRoute({
      MODEL_FAMILIES: 'claude-haiku,claude-sonnet',
      ANTHROPIC_API_KEY: 'synthetic-key',
      CHAT_TITLE_MODEL_FAMILY: 'unknown-family',
    }),
    undefined,
  );
  assert.equal(
    chatTitleRoute({
      MODEL_FAMILIES: 'claude-haiku,claude-sonnet',
      ANTHROPIC_API_KEY: 'synthetic-key',
      CHAT_TITLE_MODEL_FAMILY: 'claude-opus',
    }),
    undefined,
  );
});
