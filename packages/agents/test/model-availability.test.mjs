import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flaggedOffModels, modelAvailability, modelFamilyEnabled } from '../src/model-availability.ts';

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
