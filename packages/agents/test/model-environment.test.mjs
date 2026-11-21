import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelEnvironment } from '../src/model-environment.ts';
import { reasoningRequestFields } from '@tulipfarm/config';
import { routeCapabilities } from '../src/inference.ts';

const grok = (id, reasoningEffort, overrides = {}) => ({
  id,
  name: id,
  vendor: 'xai',
  routes: [{ provider: 'azure', model: 'grok-4.3' }],
  limits: { maxInputTokens: 200000, maxOutputTokens: 8192 },
  capabilities: { reasoningTokensInOutput: true, reasoningEffort },
  pricing: [{ usdPerMillionTokens: { input: 1.25, output: 2.5 } }],
  ...overrides,
});
const env = {
  AZURE_FOUNDRY_API_KEY: 'test-azure',
  AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
  MODEL_CATALOG: JSON.stringify({
    version: 1,
    models: [
      grok('grok-fast', 'low', { default: true }),
      grok('grok-fast-quick', 'none', { selectable: false, roles: ['title'] }),
    ],
  }),
};

test('catalog models sharing a deployment each send their own reasoning effort', t => {
  const previous = process.env.MODEL_CATALOG;
  process.env.MODEL_CATALOG = env.MODEL_CATALOG;
  t.after(() => {
    if (previous === undefined) delete process.env.MODEL_CATALOG;
    else process.env.MODEL_CATALOG = previous;
  });
  const environment = modelEnvironment(env);
  const effort = id => {
    const capabilities = routeCapabilities(environment.inference(environment.resolve(id)));
    return [capabilities.reasoningEffort, reasoningRequestFields(capabilities)];
  };
  assert.deepEqual(effort('grok-fast'), ['low', { reasoning_effort: 'low' }]);
  assert.deepEqual(effort('grok-fast-quick'), ['none', { reasoning_effort: 'none' }]);
});
