import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentModelChoices,
  flaggedOffModels,
  modelAvailability,
  modelFamilyEnabled,
} from '../src/model-availability.ts';

const model = (id, overrides = {}) => ({
  id,
  name: id,
  vendor: 'anthropic',
  routes: [{ provider: 'anthropic', model: `${id}-1` }],
  limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
  pricing: [{ usdPerMillionTokens: { input: 3, output: 15 } }],
  ...overrides,
});
const catalog = JSON.stringify({
  version: 1,
  models: [
    model('claude-sonnet', { default: true }),
    model('claude-opus', { featureFlag: 'anthropic-models' }),
    model('gpt-sol', {
      vendor: 'openai',
      routes: [{ provider: 'openai', model: 'gpt-sol-1' }],
      featureFlag: 'openai-models',
    }),
  ],
  imageModels: [
    {
      id: 'gpt-image',
      name: 'GPT Image',
      vendor: 'openai',
      routes: [{ provider: 'openai', model: 'gpt-image-1', api: 'openai-images' }],
      default: true,
      featureFlag: 'openai-image-models',
      aspects: { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
      pricing: 'unmetered',
    },
  ],
});
const tx = {
  schema: 'ws_11111111111141118111111111111111',
  client: { query: async () => ({ rows: [] }) },
};

function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
}

test('a model whose workspace flag is off is left out of availability and refused', async t => {
  withEnv(t, {
    MODEL_CATALOG: catalog,
    FEATURE_FLAG_OPENAI_MODELS: 'false',
    FEATURE_FLAG_ANTHROPIC_MODELS: 'true',
  });
  assert.deepEqual([...(await flaggedOffModels(tx))], ['gpt-sol']);
  assert.deepEqual(
    (await modelAvailability(tx)).map(row => row.familyId),
    ['claude-sonnet', 'claude-opus', 'gpt-image'],
  );
  assert.equal(await modelFamilyEnabled(tx, 'gpt-sol'), false);
  assert.equal(await modelFamilyEnabled(tx, 'claude-opus'), true);
});

test('models behind flags that are on stay available', async t => {
  withEnv(t, {
    MODEL_CATALOG: catalog,
    FEATURE_FLAG_OPENAI_MODELS: 'true',
    FEATURE_FLAG_ANTHROPIC_MODELS: 'true',
  });
  assert.deepEqual([...(await flaggedOffModels(tx))], []);
  assert.equal(await modelFamilyEnabled(tx, 'gpt-sol'), true);
});

test('an image model whose workspace flag is off is left out of availability', async t => {
  withEnv(t, {
    MODEL_CATALOG: catalog,
    FEATURE_FLAG_OPENAI_MODELS: 'true',
    FEATURE_FLAG_ANTHROPIC_MODELS: 'true',
    FEATURE_FLAG_OPENAI_IMAGE_MODELS: 'false',
  });
  assert.deepEqual([...(await flaggedOffModels(tx))], ['gpt-image']);
  assert.equal(await modelFamilyEnabled(tx, 'gpt-image'), false);
});

test('an image model whose workspace flag is on is available', async t => {
  withEnv(t, {
    MODEL_CATALOG: catalog,
    FEATURE_FLAG_OPENAI_MODELS: 'true',
    FEATURE_FLAG_ANTHROPIC_MODELS: 'true',
    FEATURE_FLAG_OPENAI_IMAGE_MODELS: 'true',
  });
  assert.equal(await modelFamilyEnabled(tx, 'gpt-image'), true);
});

test('agent model choices list enabled chat models with their price and mark the default', async t => {
  withEnv(t, {
    MODEL_CATALOG: catalog,
    ANTHROPIC_API_KEY: 'test-placeholder',
    OPENAI_API_KEY: 'test-placeholder',
    FEATURE_FLAG_OPENAI_MODELS: 'false',
    FEATURE_FLAG_ANTHROPIC_MODELS: 'true',
  });
  const choices = await agentModelChoices(tx);
  assert.deepEqual(
    choices.map(choice => [choice.id, choice.default]),
    [
      ['claude-sonnet', true],
      ['claude-opus', false],
    ],
  );
  assert.deepEqual(choices[0].usdPerMillionTokens, { input: 3, output: 15 });
});

test("a plan model is offered only while its plan's workspace flag is on", async t => {
  const plans = JSON.stringify({
    ...JSON.parse(catalog),
    models: [
      ...JSON.parse(catalog).models,
      model('chatgpt-luna', {
        vendor: 'openai',
        routes: [{ provider: 'chatgpt', model: 'gpt-6-luna' }],
        pricing: 'unmetered',
      }),
    ],
  });
  withEnv(t, { MODEL_CATALOG: plans, FEATURE_FLAG_CHATGPT_PLAN: 'false' });
  assert.equal(await modelFamilyEnabled(tx, 'chatgpt-luna'), false);
  process.env.FEATURE_FLAG_CHATGPT_PLAN = 'true';
  assert.equal(await modelFamilyEnabled(tx, 'chatgpt-luna'), true);
});
