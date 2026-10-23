import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  modelCapabilities,
  modelCapabilitiesSchema,
  modelCatalogFileSchema,
  providerModelCapabilities,
  resolveModelCapabilities,
} from '../dist/index.js';

const shippedCatalog = JSON.parse(readFileSync(new URL('../catalog/models.json', import.meta.url), 'utf8'));

// The wire behaviour each shipped model had before the catalog file, on every route.
const shipped = {
  'claude-haiku': { toolChoice: 'forced', responseModelAliases: ['claude-haiku-4-5-20251001'] },
  'claude-sonnet': { toolChoice: 'auto' },
  'claude-opus': { toolChoice: 'auto' },
  'claude-fable': { toolChoice: 'auto' },
  'gpt-luna': { reasoningOffForTools: true },
  'gpt-sol': { reasoningOffForTools: true },
  'gpt-astra': { api: 'responses' },
  grok: { reasoningTokensInOutput: true },
  'grok-fast': { reasoningTokensInOutput: true },
};

test('every shipped model resolves the capabilities that reproduce its previous wire behaviour', () => {
  for (const model of shippedCatalog.models)
    for (const route of model.routes)
      assert.deepEqual(
        modelCapabilities(route.provider, route.model),
        { ...providerModelCapabilities[route.provider], ...shipped[model.id] },
        `${model.id} ${route.provider}`,
      );
  assert.deepEqual(providerModelCapabilities.anthropic, {
    api: 'anthropic-messages',
    toolChoice: 'forced',
    reasoningOffForTools: false,
    reasoningTokensInOutput: false,
    imageInput: false,
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
  const models = structuredClone(shippedCatalog.models).map(model => {
    delete model.capabilities;
    return model;
  });
  const parse = rows => modelCatalogFileSchema.safeParse({ ...shippedCatalog, models: rows });
  assert.equal(parse(models).success, true);
  assert.equal(modelCapabilitiesSchema.safeParse({}).success, true);
  for (const invalid of [
    { api: 'completions' },
    { toolChoice: 'required' },
    { streaming: 'yes' },
    { responseModelAliases: ['bad id'] },
    { unknown: true },
  ])
    assert.equal(modelCapabilitiesSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  const wrongApi = models.map(model =>
    model.id === 'claude-opus' ? { ...model, capabilities: { api: 'responses' } } : model,
  );
  assert.match(JSON.stringify(parse(wrongApi).error.issues), /does not support this API/);
  const azureResponses = models.map(model =>
    model.id === 'kimi' ? { ...model, capabilities: { api: 'responses' } } : model,
  );
  assert.equal(parse(azureResponses).success, true);
});
