import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadModelCatalog, shippedModelCatalogPath } from '../src/model-catalog-loader.ts';
import { resolveModelBundle, servedModelBundle, verifyServerModelBundle } from '../src/model-bundle.ts';
import { initialModelMapping } from '../src/model-continuity.ts';
import { calculateModelCost, calculateUsageCost, reserveModelCost } from '../src/model-cost.ts';

const fixture = name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));
const azure = {
  AZURE_FOUNDRY_API_KEY: 'test-key',
  AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com',
};
const tokens = {
  input: 1000,
  output: 1000,
  cacheRead: 100,
  cacheWrite: 0,
  cacheWrite5m: 10,
  cacheWrite1h: 0,
};
const usage = { kind: 'known', tokens };

// Bundles the served catalog of `env` and meters `tokens` for `familyId` through it.
function meter(env, familyId, metered = usage) {
  const served = loadModelCatalog(env);
  const { bundle } = servedModelBundle(served);
  const resolution = resolveModelBundle({
    bundle,
    familyId,
    allowedProviders: [served.model(familyId).route.type],
    allowedLocations: ['server'],
  });
  const model = bundle.models.find(item => item.id === resolution.modelId);
  const quote = {
    modelId: model.id,
    pricingRevision: resolution.pricingRevision,
    rates: model.rates,
    maxInputTokens: 2000,
    maxOutputTokens: 2000,
    date: '2026-10-19',
  };
  return {
    bundle,
    rates: model.rates,
    pricingRevision: resolution.pricingRevision,
    cost: calculateModelCost({
      resolution,
      usage: metered,
      date: '2026-10-19',
      trustedBundle: bundle,
    }).providerPicoUsd,
    usage: calculateUsageCost({ ...quote, usage: metered }).providerPicoUsd,
    reserved: reserveModelCost(quote),
  };
}

test('the shipped catalog keeps its prices, revisions and costs', () => {
  const output = meter({ ANTHROPIC_API_KEY: 'test-key' }, 'claude-haiku');
  // 1000 input at $1, 1000 output at $5, 100 cache reads at $0.10 and 10 five-minute cache writes at $1.25 per million.
  assert.equal(output.cost, '6022500000');
  assert.equal(output.usage, output.cost);
  assert.equal(output.pricingRevision, initialModelMapping.pricingRevision);
  assert.equal(output.pricingRevision, 'prices-2026-10-19.1');
});

test('an operator catalog with its own prices changes metered cost and the pricing revision', () => {
  const env = {
    ...azure,
    MODEL_CATALOG_FILE: fixture('model-catalog-acme.json'),
  };
  const listed = meter(env, 'acme-chat');
  const repriced = meter({ ...env, MODEL_CATALOG_FILE: fixture('model-catalog-repriced.json') }, 'acme-chat');
  // 1000 input at $0.50, 1000 output at $1.50, 100 cache reads at $0.05 and 10 cache writes at $0.625 per million.
  assert.equal(listed.cost, '2011250000');
  assert.equal(repriced.cost, '8045000000', 'the repriced catalog charges four times as much');
  assert.match(repriced.pricingRevision, /^prices-[0-9a-f]{32}$/);
  assert.notEqual(repriced.pricingRevision, listed.pricingRevision);
});

test('an unmetered model records usage at zero cost', () => {
  const output = meter({ ...azure, MODEL_CATALOG_FILE: fixture('model-catalog-unmetered.json') }, 'local-chat');
  assert.deepEqual([output.cost, output.usage, output.reserved], ['0', '0', '0']);
  assert.deepEqual(output.rates, [
    {
      validFrom: null,
      validUntilExclusive: null,
      promptTokensAbove: null,
      usdPerMillionTokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    },
  ]);
});

test('a stored server bundle keeps the prices it started with after the catalog changes', () => {
  const started = meter({ ...azure, MODEL_CATALOG_FILE: fixture('model-catalog-acme.json') }, 'acme-chat');
  const stored = JSON.parse(JSON.stringify(started.bundle));
  // The deployment now serves the repriced catalog; runs on the stored bundle settle at its own prices.
  meter({ ...azure, MODEL_CATALOG_FILE: fixture('model-catalog-repriced.json') }, 'acme-chat');
  const bundle = verifyServerModelBundle(stored.id, stored);
  const resolution = resolveModelBundle({
    bundle,
    familyId: 'acme-chat',
    allowedProviders: ['azure'],
    allowedLocations: ['server'],
  });
  assert.equal(
    calculateModelCost({
      resolution,
      usage,
      date: '2026-10-19',
      trustedBundle: bundle,
    }).providerPicoUsd,
    started.cost,
  );
});

test('GPT long-context tiers and the Gemini promotion retain their published boundaries', () => {
  for (const id of ['gpt-luna', 'gpt-sol', 'gpt-astra'])
    assert.deepEqual(
      shipped.models.find(model => model.id === id).pricing.map(rate => rate.promptTokensAbove ?? null),
      [null, 272000],
      id,
    );
  assert.deepEqual(
    shipped.models
      .find(model => model.id === 'gemini-flash')
      .pricing.map(rate => [
        rate.validFrom ?? null,
        rate.validUntilExclusive ?? null,
        rate.usdPerMillionTokens.input,
        rate.usdPerMillionTokens.output,
      ]),
    [
      [null, '2027-01-01', 0.75, 3.75],
      ['2027-01-01', null, 1.5, 7.5],
    ],
  );
});
