import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initialModelMapping, legacyModels, shippedModelCatalogPath } from '@tulipfarm/config';
import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import { chatFallbackModel, chatReplyModel, conversationModel, roleModel } from '../src/conversation-model.ts';
import { chatTitleRoute, meteredReply } from '../src/conversation-activities.ts';

const runtime = { transaction: async () => assert.fail('An unavailable model must not reach storage') };
const keys = {
  ANTHROPIC_API_KEY: 'synthetic-key',
  AZURE_FOUNDRY_API_KEY: 'synthetic-key',
  AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
};
const shipped = { ANTHROPIC_API_KEY: 'synthetic-key' };
const catalogModels = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8')).models;
const legacyModel = id => legacyModels.find(model => model.id === id);
// A catalog of Claude Haiku and Claude Sonnet (the default) with only the `roles` given.
const claudeCatalog = roles =>
  JSON.stringify({
    version: 1,
    models: catalogModels
      .filter(model => ['claude-haiku', 'claude-sonnet'].includes(model.id))
      .map(model => ({ ...model, roles: roles[model.id] ?? [] })),
  });

function environment(t, values) {
  const previous = process.env;
  process.env = { SLACK_OUTBOUND_ENABLED: 'false', KNOWLEDGE_EMBEDDINGS_ENABLED: 'false', ...values };
  t.after(() => {
    process.env = previous;
  });
}

/** The route and price the worker built from the static price list before chat resolved through the model environment. */
function previousModel(family) {
  const model = legacyModel(initialModelMapping.families.find(item => item.id === family).modelId);
  const common = {
    endpoint: model.provider === 'anthropic' ? 'https://api.anthropic.com/' : keys.AZURE_FOUNDRY_ENDPOINT,
    model: model.providerModelId,
  };
  const route =
    model.provider === 'anthropic'
      ? { provider: 'anthropic', ...common, apiKey: keys.ANTHROPIC_API_KEY }
      : { provider: 'azure', ...common, auth: { kind: 'api-key', value: keys.AZURE_FOUNDRY_API_KEY } };
  const maxOutputTokens = Math.min(4096, model.maxOutputTokens);
  return {
    route: { ...route, timeoutMs: 45000, maxOutputTokens },
    price: {
      familyId: family,
      modelId: model.id,
      pricingRevision: initialModelMapping.pricingRevision,
      rates: model.rates,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens,
    },
  };
}

test('every enabled family keeps the route and price chat used before, and tasks use the same route', () => {
  // Gemini families were not selectable before; their routes are covered by the default-provider tests.
  const families = catalogModels.filter(family => family.vendor !== 'google').map(family => family.id);
  const env = keys;
  for (const family of families) {
    assert.deepEqual(conversationModel(family, env), previousModel(family), family);
    assert.deepEqual(conversationModel(family, env).route, modelEnvironment(env).route(family), family);
  }
});

test('the shipped default families resolve for chat and titles as before', () => {
  assert.deepEqual(conversationModel('claude-sonnet', shipped), previousModel('claude-sonnet'));
  assert.deepEqual(conversationModel('claude-haiku', shipped), previousModel('claude-haiku'));
  assert.deepEqual(chatTitleRoute(shipped), { ...previousModel('claude-haiku').route, maxOutputTokens: 256 });
});

test('a family the catalog does not serve has no model, and chat replies move to the default model', () => {
  assert.equal(conversationModel('gpt-sol', shipped), null, 'skipped without an Azure or OpenAI key');
  assert.equal(conversationModel('unknown-family', shipped), null);
  for (const family of ['gpt-sol', 'unknown-family'])
    assert.deepEqual(chatReplyModel(family, shipped), previousModel('claude-sonnet'), family);
  assert.deepEqual(chatReplyModel('claude-opus', shipped).price.familyId, 'claude-opus');
});

test('roles without a model: titles use the chat model, other roles the default model', () => {
  const env = { ...shipped, MODEL_CATALOG: claudeCatalog({}) };
  assert.equal(chatTitleRoute(env), undefined);
  assert.equal(roleModel('title', env), null);
  for (const role of ['compaction', 'review', 'plan', 'heartbeat'])
    assert.equal(roleModel(role, env).price.familyId, 'claude-sonnet', role);
  const assigned = { ...shipped, MODEL_CATALOG: claudeCatalog({ 'claude-haiku': ['review', 'title'] }) };
  assert.equal(roleModel('review', assigned).price.familyId, 'claude-haiku');
  assert.equal(chatTitleRoute(assigned).model, 'claude-haiku-4-5');
});

test('the chat fallback is off without a fallback-role model and never the chat model itself', () => {
  assert.equal(chatFallbackModel('claude-sonnet', { ...shipped, MODEL_CATALOG: claudeCatalog({}) }), undefined);
  const env = { ...shipped, MODEL_CATALOG: claudeCatalog({ 'claude-haiku': ['fallback'] }) };
  assert.equal(chatFallbackModel('claude-sonnet', env).price.familyId, 'claude-haiku');
  assert.equal(chatFallbackModel('claude-haiku', env), undefined);
});

test('chat rejects a reply when no model can serve it', async t => {
  environment(t, {});
  const reply = meteredReply(runtime, { mcp: null });
  await assert.rejects(
    reply({ model: 'claude-opus', messages: [], executeTool: () => assert.fail('No tool may run'), fence: {} }),
    /no model has a route with its key set/,
  );
});

const providerKeys = {
  anthropic: { ANTHROPIC_API_KEY: 'synthetic-key' },
  openai: { OPENAI_API_KEY: 'synthetic-key' },
  xai: { XAI_API_KEY: 'synthetic-key' },
  google: { GEMINI_API_KEY: 'synthetic-key' },
  azure: { AZURE_FOUNDRY_API_KEY: 'synthetic-key', AZURE_FOUNDRY_ENDPOINT: keys.AZURE_FOUNDRY_ENDPOINT },
};
const providerFamilies = {
  anthropic: ['claude-haiku', 'claude-sonnet', 'claude-opus', 'claude-fable'],
  openai: ['gpt-luna', 'gpt-sol', 'gpt-astra'],
  xai: ['grok', 'grok-fast'],
  google: ['gemini-flash', 'gemini-pro'],
  azure: [
    'gpt-luna',
    'gpt-sol',
    'gpt-astra',
    'deepseek-pro',
    'deepseek-flash',
    'grok',
    'grok-fast',
    'kimi',
    'kimi-code',
  ],
};
const providerEndpoints = {
  anthropic: 'https://api.anthropic.com/',
  openai: 'https://api.openai.com/',
  xai: 'https://api.x.ai/',
  google: 'https://generativelanguage.googleapis.com/',
  azure: keys.AZURE_FOUNDRY_ENDPOINT,
};

for (const [provider, env] of Object.entries(providerKeys))
  test(`${provider} credentials alone enable the families ${provider} serves, priced from its own catalog entry`, () => {
    const enabled = catalogModels.map(family => family.id).filter(family => conversationModel(family, env));
    assert.deepEqual(enabled, providerFamilies[provider]);
    for (const family of enabled) {
      const { route, price } = conversationModel(family, env);
      const model = legacyModel(price.modelId);
      assert.equal(route.provider, provider, family);
      assert.equal(model.provider, provider, family);
      assert.equal(route.endpoint, providerEndpoints[provider], family);
      assert.equal(route.model, model.providerModelId, family);
      assert.deepEqual(price.rates, model.rates, family);
      assert.deepEqual(conversationModel(family, env).route, modelEnvironment(env).route(family), family);
    }
  });

test('a family runs on the catalog-preferred provider when both of its providers have credentials', () => {
  const env = { ...providerKeys.openai, ...providerKeys.xai, ...providerKeys.azure };
  for (const family of ['gpt-luna', 'gpt-sol', 'gpt-astra', 'grok', 'grok-fast'])
    assert.equal(conversationModel(family, env).route.provider, 'azure', family);
  const direct = { ...providerKeys.openai, ...providerKeys.xai };
  assert.equal(conversationModel('gpt-luna', direct).price.modelId, 'gpt-6-luna-openai');
  assert.equal(conversationModel('grok', direct).price.modelId, 'grok-4-6-xai');
  assert.equal(conversationModel('grok', direct).route.provider, 'xai');
});
