import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  modelCapabilities,
  modelCapabilitiesSchema,
  modelFamilies,
  modelFamilyCatalogSchema,
  modelPricing,
  providerModelCapabilities,
  resolveModelCapabilities,
} from '../dist/index.js';

const shipped = {
  'claude-haiku-4-5': { toolChoice: 'forced', responseModelAliases: ['claude-haiku-4-5-20251001'] },
  'claude-sonnet-5': { toolChoice: 'auto' },
  'claude-opus-5-5': { toolChoice: 'auto' },
  'claude-fable-5-1': { toolChoice: 'auto' },
  'gpt-6-luna': { reasoningOffForTools: true },
  'gpt-6-sol': { reasoningOffForTools: true },
  'gpt-6-astra': { api: 'responses' },
  'grok-4-6': { reasoningTokensInOutput: true },
  'grok-4': { reasoningTokensInOutput: true },
  'grok-4.3': { reasoningTokensInOutput: true },
  'gpt-6-luna-openai': { reasoningOffForTools: true },
  'gpt-6-sol-openai': { reasoningOffForTools: true },
  'gpt-6-astra-openai': { api: 'responses' },
  'grok-4-6-xai': { reasoningTokensInOutput: true },
  'grok-4.3-xai': { reasoningTokensInOutput: true },
};

test('every shipped model resolves the capabilities that reproduce its previous wire behaviour', () => {
  for (const model of modelPricing.models) {
    const expected = { ...providerModelCapabilities[model.provider], ...shipped[model.id] };
    assert.deepEqual(modelCapabilities(model.provider, model.providerModelId), expected, model.id);
  }
  assert.deepEqual(providerModelCapabilities.anthropic, {
    api: 'anthropic-messages',
    toolChoice: 'forced',
    reasoningOffForTools: false,
    reasoningTokensInOutput: false,
    streaming: true,
    responseModelAliases: [],
  });
  assert.deepEqual(providerModelCapabilities.azure, {
    ...providerModelCapabilities.anthropic,
    api: 'chat-completions',
  });
  for (const provider of ['openai', 'xai'])
    assert.deepEqual(providerModelCapabilities[provider], providerModelCapabilities.azure, provider);
  assert.deepEqual(providerModelCapabilities.google, {
    ...providerModelCapabilities.anthropic,
    api: 'gemini',
  });
});

test('unknown models use provider defaults and later layers override earlier ones', () => {
  assert.deepEqual(modelCapabilities('azure', 'custom-deployment'), providerModelCapabilities.azure);
  assert.equal(modelCapabilities('anthropic', 'gpt-6-astra').api, 'anthropic-messages');
  assert.deepEqual(modelCapabilities('azure', 'gpt-6-astra', { toolChoice: 'auto' }), {
    ...providerModelCapabilities.azure,
    api: 'responses',
    toolChoice: 'auto',
  });
  assert.equal(modelCapabilities('azure', 'gpt-6-astra', { api: 'chat-completions' }).api, 'chat-completions');
  assert.equal(resolveModelCapabilities('azure', { streaming: false }, { streaming: undefined }).streaming, false);
  assert.throws(() => resolveModelCapabilities('anthropic', { api: 'responses' }), /not supported/);
  assert.throws(() => modelCapabilities('google', 'custom', { api: 'chat-completions' }), /not supported/);
});

test('capabilities are optional, strict and checked against the provider', () => {
  const rows = structuredClone(modelFamilies).map(family => {
    delete family.capabilities;
    return family;
  });
  assert.equal(modelFamilyCatalogSchema.safeParse(rows).success, true);
  assert.equal(modelCapabilitiesSchema.safeParse({}).success, true);
  for (const invalid of [
    { api: 'completions' },
    { toolChoice: 'required' },
    { streaming: 'yes' },
    { responseModelAliases: ['bad id'] },
    { unknown: true },
  ])
    assert.equal(modelCapabilitiesSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  const wrongApi = rows.map(family =>
    family.id === 'claude-opus' ? { ...family, capabilities: { api: 'responses' } } : family,
  );
  assert.match(
    modelFamilyCatalogSchema.safeParse(wrongApi).error.message,
    /Model API must be supported by its provider/,
  );
  const azureResponses = rows.map(family =>
    family.id === 'kimi' ? { ...family, capabilities: { api: 'responses' } } : family,
  );
  assert.equal(modelFamilyCatalogSchema.safeParse(azureResponses).success, true);
});
