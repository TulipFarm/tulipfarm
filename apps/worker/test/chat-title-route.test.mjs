import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatTitleRoute } from '../src/conversation-activities.ts';

const anthropic = { ANTHROPIC_API_KEY: 'synthetic-key' };
const catalog = roles =>
  JSON.stringify({
    version: 1,
    models: [
      {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        vendor: 'anthropic',
        routes: [{ provider: 'anthropic', model: 'claude-sonnet-5' }],
        default: true,
        roles,
        limits: { maxInputTokens: 1000000, maxOutputTokens: 128000 },
        pricing: [{ usdPerMillionTokens: { input: 3, output: 15 } }],
      },
    ],
  });

test('chat titles default to the priced Claude Haiku route with a small output limit', () => {
  assert.deepEqual(chatTitleRoute(anthropic), {
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com/',
    model: 'claude-haiku-4-5',
    apiKey: 'synthetic-key',
    timeoutMs: 45000,
    maxOutputTokens: 256,
  });
});

test('chat titles use the chat route when no served model has the title role', () => {
  assert.equal(chatTitleRoute({ ...anthropic, MODEL_CATALOG: catalog([]) }), undefined);
  assert.equal(
    chatTitleRoute({ OPENAI_API_KEY: 'synthetic-key' }),
    undefined,
    'Claude Haiku is skipped without an Anthropic key',
  );
  assert.equal(chatTitleRoute({ ...anthropic, MODEL_CATALOG: catalog(['title']) }).model, 'claude-sonnet-5');
});
