import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateKnowledgeEmbeddingCost, parseKnowledgeEmbeddingsConfig } from '../src/knowledge-embeddings.ts';

const enabledEnv = {
  KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
  AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
  AZURE_FOUNDRY_API_KEY: 'synthetic-key',
};

test('absent embedding opt-in is disabled regardless of chat settings or credentials', () => {
  assert.deepEqual(parseKnowledgeEmbeddingsConfig({}), { kind: 'disabled' });
  assert.deepEqual(
    parseKnowledgeEmbeddingsConfig({
      MODEL_CATALOG_FILE: 'missing.json',
      AZURE_FOUNDRY_ENDPOINT: 'bad',
    }),
    {
      kind: 'disabled',
    },
  );
  assert.deepEqual(
    parseKnowledgeEmbeddingsConfig({
      ...enabledEnv,
      KNOWLEDGE_EMBEDDINGS_ENABLED: 'false',
    }),
    {
      kind: 'disabled',
    },
  );
  const enabled = parseKnowledgeEmbeddingsConfig(enabledEnv);
  assert.equal(enabled.kind, 'enabled');
  assert.equal(enabled.profile.id, 'azure-eastus-text-embedding-3-large-v1-1536-cl100k-prep1');
  assert.throws(() => {
    enabled.profile.dimensions = 3072;
  }, TypeError);
  assert.throws(() => {
    enabled.profile.pricing.providerPicoUsdPerToken = '1';
  }, TypeError);
});

test('enabled settings fail closed without disclosing environment values', () => {
  for (const change of [
    { KNOWLEDGE_EMBEDDINGS_ENABLED: '1' },
    { AZURE_FOUNDRY_API_KEY: undefined },
    { AZURE_FOUNDRY_API_KEY: 'secret\nvalue' },
    {
      AZURE_FOUNDRY_ENDPOINT: 'https://user:pass@other.services.ai.azure.com/',
    },
    { AZURE_FOUNDRY_ENDPOINT: 'not a url' },
    { KNOWLEDGE_EMBEDDINGS_PROVIDER: 'cohere' },
    { KNOWLEDGE_EMBEDDINGS_DIMENSIONS: '3072' },
    { KNOWLEDGE_EMBEDDINGS_MODEL: 'bad model' },
    {
      AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/?secret=value',
    },
    { AZURE_FOUNDRY_ENDPOINT: 'http://example.services.ai.azure.com/' },
    { VITE_AZURE_FOUNDRY_API_KEY: 'private' },
    { PUBLIC_KNOWLEDGE_EMBEDDINGS_ENABLED: 'true' },
    { NEXT_PUBLIC_AZURE_FOUNDRY_ENDPOINT: 'private' },
  ])
    assert.throws(() => parseKnowledgeEmbeddingsConfig({ ...enabledEnv, ...change }), {
      message: 'Invalid server knowledge embeddings configuration',
    });
});

test('the Azure Foundry endpoint is required and accepts any secure resource', () => {
  const production = parseKnowledgeEmbeddingsConfig(enabledEnv);
  assert.deepEqual(
    { ...production, profile: undefined },
    {
      kind: 'enabled',
      provider: 'azure-foundry',
      endpoint: 'https://example.services.ai.azure.com/',
      apiKey: 'synthetic-key',
      requestModel: 'text-embedding-3-large',
      profile: undefined,
    },
  );
  assert.throws(
    () =>
      parseKnowledgeEmbeddingsConfig({
        ...enabledEnv,
        AZURE_FOUNDRY_ENDPOINT: undefined,
      }),
    {
      message: 'Invalid server knowledge embeddings configuration',
    },
  );
  const other = parseKnowledgeEmbeddingsConfig({
    ...enabledEnv,
    AZURE_FOUNDRY_ENDPOINT: 'https://other.services.ai.azure.com',
    KNOWLEDGE_EMBEDDINGS_MODEL: 'embeddings-large',
    KNOWLEDGE_EMBEDDINGS_DIMENSIONS: '1536',
  });
  assert.equal(other.endpoint, 'https://other.services.ai.azure.com/');
  assert.equal(other.requestModel, 'embeddings-large');
  assert.equal(other.profile.id, 'azure-eastus-text-embedding-3-large-v1-1536-cl100k-prep1');
});

test('OpenAI-compatible embeddings use their own base URL and key with the stored profile', () => {
  const env = {
    KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
    KNOWLEDGE_EMBEDDINGS_PROVIDER: 'openai-compatible',
    KNOWLEDGE_EMBEDDINGS_BASE_URL: 'https://api.openai.com/v1',
    KNOWLEDGE_EMBEDDINGS_API_KEY: 'synthetic-openai-key',
  };
  const config = parseKnowledgeEmbeddingsConfig({
    ...env,
    AZURE_FOUNDRY_API_KEY: 'unused',
  });
  assert.deepEqual(
    { ...config, profile: undefined },
    {
      kind: 'enabled',
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1/',
      apiKey: 'synthetic-openai-key',
      requestModel: 'text-embedding-3-large',
      profile: undefined,
    },
  );
  assert.equal(config.profile.dimensions, 1536);
  assert.equal(
    parseKnowledgeEmbeddingsConfig({
      ...env,
      KNOWLEDGE_EMBEDDINGS_BASE_URL: 'http://127.0.0.1:4000/v1/',
    }).endpoint,
    'http://127.0.0.1:4000/v1/',
  );
  assert.equal(
    parseKnowledgeEmbeddingsConfig({
      ...env,
      KNOWLEDGE_EMBEDDINGS_MODEL: 'openai/text-embedding-3-large',
    }).requestModel,
    'openai/text-embedding-3-large',
  );
  for (const change of [
    { KNOWLEDGE_EMBEDDINGS_BASE_URL: undefined },
    { KNOWLEDGE_EMBEDDINGS_BASE_URL: 'http://gateway.example/v1' },
    { KNOWLEDGE_EMBEDDINGS_BASE_URL: 'https://gateway.example/v1?key=secret' },
    { KNOWLEDGE_EMBEDDINGS_API_KEY: undefined },
    { KNOWLEDGE_EMBEDDINGS_DIMENSIONS: '768' },
  ])
    assert.throws(() => parseKnowledgeEmbeddingsConfig({ ...env, ...change }), {
      message: 'Invalid server knowledge embeddings configuration',
    });
});

test('embedding costs retain exact pico-USD without output tokens or per-call rounding', () => {
  assert.deepEqual(calculateKnowledgeEmbeddingCost({ inputTokens: 3, date: '2026-10-03' }), {
    providerPicoUsd: '390000',
    pricingRevision: 'azure-eastus-embedding-3-large-global-2026-10-03',
    date: '2026-10-03',
  });
  assert.equal(
    calculateKnowledgeEmbeddingCost({
      inputTokens: 1000000,
      date: '2026-10-03',
    }).providerPicoUsd,
    '130000000000',
  );
  assert.equal(
    calculateKnowledgeEmbeddingCost({
      inputTokens: Number.MAX_SAFE_INTEGER,
      date: '2026-10-03',
    }).providerPicoUsd,
    '1170935903116328830000',
  );
  assert.equal(calculateKnowledgeEmbeddingCost({ inputTokens: 0, date: '2026-10-03' }).providerPicoUsd, '0');
  for (const inputTokens of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculateKnowledgeEmbeddingCost({ inputTokens, date: '2026-10-03' }), {
      message: 'Invalid knowledge embedding cost input',
    });
  }
  assert.throws(() => calculateKnowledgeEmbeddingCost({ inputTokens: 1, date: '2024-05-31' }), {
    message: 'Invalid knowledge embedding cost input',
  });
});
