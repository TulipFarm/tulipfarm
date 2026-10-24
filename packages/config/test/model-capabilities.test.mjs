import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  modelCapabilities,
  modelCapabilitiesSchema,
  modelImageLimits,
  modelCatalogFileSchema,
  providerModelCapabilities,
  resolveModelCapabilities,
} from '../dist/index.js';

const shippedCatalog = JSON.parse(readFileSync(new URL('../catalog/models.json', import.meta.url), 'utf8'));

// The wire behaviour each shipped model had before the catalog file, on every route, plus its declared image input.
const shipped = {
  'claude-haiku': { toolChoice: 'forced', responseModelAliases: ['claude-haiku-4-5-20251001'], imageInput: true },
  'claude-sonnet': { toolChoice: 'auto', imageInput: true },
  'claude-opus': { toolChoice: 'auto', imageInput: true },
  'claude-fable': { toolChoice: 'auto', imageInput: true },
  'gpt-luna': { reasoningOffForTools: true, imageInput: true },
  'gpt-sol': { reasoningOffForTools: true, imageInput: true },
  'gpt-astra': { api: 'responses', imageInput: true },
  grok: { reasoningTokensInOutput: true, imageInput: true },
  'grok-fast': { reasoningTokensInOutput: true },
  kimi: { imageInput: true },
  'kimi-code': { imageInput: true },
  'gemini-flash': { imageInput: true },
  'gemini-pro': { imageInput: true },
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
    imageInput: true,
  });
  assert.equal(modelCapabilities('azure', 'gpt-6-astra', { api: 'chat-completions' }).api, 'chat-completions');
  assert.equal(resolveModelCapabilities('azure', { streaming: false }, { streaming: undefined }).streaming, false);
  assert.throws(() => resolveModelCapabilities('anthropic', { api: 'responses' }), /not supported/);
  assert.throws(() => modelCapabilities('google', 'custom', { api: 'chat-completions' }), /not supported/);
});

test('capabilities are optional, strict and checked against the provider', () => {
  const models = structuredClone(shippedCatalog.models).map(model => {
    delete model.capabilities;
    delete model.limits.imageInputTokens;
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

test('image limits come from the catalog model a route serves, else the defaults', t => {
  const catalog = structuredClone(shippedCatalog);
  const haiku = catalog.models.find(model => model.routes.some(route => route.model === 'claude-haiku-4-5'));
  haiku.capabilities = { ...haiku.capabilities, imageInput: true };
  haiku.limits = { ...haiku.limits, imageInputTokens: 2400, maxImageBytes: 1048576 };
  t.after(() => delete process.env.MODEL_CATALOG);
  process.env.MODEL_CATALOG = JSON.stringify(catalog);
  assert.deepEqual(modelImageLimits('anthropic', 'claude-haiku-4-5'), {
    imageInputTokens: 2400,
    maxImageBytes: 1048576,
  });
  assert.deepEqual(modelImageLimits('anthropic', 'custom-model'), { imageInputTokens: 1600, maxImageBytes: 5242880 });
  assert.deepEqual(modelImageLimits('google', 'claude-haiku-4-5'), { imageInputTokens: 1600, maxImageBytes: 5242880 });
});

test('shipped models reserve the per-image token bound their provider documents', () => {
  const declared = Object.fromEntries(
    shippedCatalog.models.map(({ id, routes: [{ provider, model }] }) => {
      const { imageInputTokens, maxImageBytes } = modelImageLimits(provider, model);
      return [id, [modelCapabilities(provider, model).imageInput, imageInputTokens, maxImageBytes]];
    }),
  );
  assert.deepEqual(declared, {
    'claude-haiku': [true, 1600, 5242880],
    'claude-sonnet': [true, 1600, 5242880],
    'claude-opus': [true, 4800, 5242880],
    'claude-fable': [true, 4800, 5242880],
    'gpt-luna': [true, 3000, 5242880],
    'gpt-sol': [true, 3000, 5242880],
    'gpt-astra': [true, 3000, 5242880],
    'deepseek-pro': [false, 1600, 5242880],
    'deepseek-flash': [false, 1600, 5242880],
    grok: [true, 1600, 5242880],
    'grok-fast': [false, 1600, 5242880],
    kimi: [true, 1600, 5242880],
    'kimi-code': [true, 1600, 5242880],
    'gemini-flash': [true, 2240, 5242880],
    'gemini-pro': [true, 2240, 5242880],
  });
});
