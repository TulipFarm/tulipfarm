import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialModelMapping, modelPricing, selectableModelFamilies } from '@tulipfarm/config';
import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import { conversationModel } from '../src/conversation-model.ts';
import { chatTitleRoute, meteredReply } from '../src/conversation-activities.ts';
import { meteredSkillReviewer } from '../src/skill-activities.ts';
import { heartbeatProcessor } from '../src/google-heartbeat-activities.ts';

const runtime = { transaction: async () => assert.fail('An unavailable model must not reach storage') };
const keys = {
  ANTHROPIC_API_KEY: 'synthetic-key',
  AZURE_FOUNDRY_API_KEY: 'synthetic-key',
  AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
};
const shipped = { MODEL_FAMILIES: 'claude-haiku,claude-sonnet', ANTHROPIC_API_KEY: 'synthetic-key' };

function environment(t, values) {
  const previous = process.env;
  process.env = { SLACK_OUTBOUND_ENABLED: 'false', KNOWLEDGE_EMBEDDINGS_ENABLED: 'false', ...values };
  t.after(() => {
    process.env = previous;
  });
}

/** The route and price the worker built from the static price list before chat resolved through the model environment. */
function previousModel(family) {
  const model = modelPricing.models.find(
    candidate => candidate.id === selectableModelFamilies.find(item => item.id === family)?.currentModelId,
  );
  const common = {
    endpoint: model.provider === 'anthropic' ? 'https://api.anthropic.com/' : keys.AZURE_FOUNDRY_ENDPOINT,
    model: model.providerModelId,
  };
  const route =
    model.provider === 'anthropic'
      ? { provider: 'anthropic', ...common, apiKey: keys.ANTHROPIC_API_KEY }
      : { provider: 'azure', ...common, auth: { kind: 'api-key', value: keys.AZURE_FOUNDRY_API_KEY } };
  const maxOutputTokens = Math.min(4096, model.metadata.max_output_tokens);
  return {
    route: { ...route, timeoutMs: 45000, maxOutputTokens },
    price: {
      familyId: family,
      modelId: model.id,
      pricingRevision: initialModelMapping.pricingRevision,
      rates: model.rates,
      maxInputTokens: model.metadata.max_input_tokens,
      maxOutputTokens,
    },
  };
}

test('every enabled family keeps the route and price chat used before, and tasks use the same route', () => {
  // Gemini families were not selectable before; their routes are covered by the default-provider tests.
  const families = selectableModelFamilies.filter(family => family.vendor !== 'google').map(family => family.id);
  const env = { ...keys, MODEL_FAMILIES: families.join(',') };
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

test('a family outside MODEL_FAMILIES has no chat, title or compaction model', () => {
  assert.equal(conversationModel('claude-opus', shipped), null);
  assert.equal(
    conversationModel('claude-sonnet', { MODEL_FAMILIES: 'claude-haiku', ANTHROPIC_API_KEY: 'synthetic-key' }),
    null,
  );
  assert.equal(conversationModel('unknown-family', shipped), null);
  assert.equal(chatTitleRoute({ ...shipped, CHAT_TITLE_MODEL_FAMILY: 'claude-opus' }), undefined);
  assert.equal(chatTitleRoute({ ...shipped, MODEL_FAMILIES: 'claude-sonnet' }), undefined);
});

test('chat rejects a family outside MODEL_FAMILIES before admission', async t => {
  environment(t, shipped);
  const reply = meteredReply(runtime, { mcp: null });
  await assert.rejects(
    reply({ model: 'claude-opus', messages: [], executeTool: () => assert.fail('No tool may run'), fence: {} }),
    /conversation-model-unavailable/,
  );
});

test('skill review rejects a family outside MODEL_FAMILIES before admission', async t => {
  environment(t, { ...shipped, SKILL_REVIEW_MODEL_FAMILY: 'claude-opus' });
  const review = meteredSkillReviewer(
    runtime,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    {},
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  await assert.rejects(review({ id: 'review', files: [], unreviewedFiles: [] }), /skill-review-model-unavailable/);
});

test('the Gmail heartbeat blocks a family outside MODEL_FAMILIES before admission', async t => {
  environment(t, { ...shipped, GMAIL_HEARTBEAT_MODEL_FAMILY: 'claude-opus' });
  const authorize = () => assert.fail('An unavailable model must not be authorized');
  assert.deepEqual(await heartbeatProcessor(runtime)({ authorize, message: {}, instructions: '' }), {
    kind: 'blocked',
    reason: 'model-configuration',
  });
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
    const enabled = selectableModelFamilies.map(family => family.id).filter(family => conversationModel(family, env));
    assert.deepEqual(enabled, providerFamilies[provider]);
    for (const family of enabled) {
      const { route, price } = conversationModel(family, env);
      const model = modelPricing.models.find(candidate => candidate.id === price.modelId);
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
  assert.equal(conversationModel('grok', { ...direct, MODEL_FAMILIES: 'grok' }).route.provider, 'xai');
});
