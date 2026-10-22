import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../src/model-pricing.json' with { type: 'json' };

test('the catalog carries provider cost only; credit pricing belongs to the creditPricing extension slot', () => {
  assert.deepEqual(
    Object.keys(config.policy).filter(key => /credit|multiplier|rounding|tokenBasis/i.test(key)),
    [],
  );
  for (const model of config.models)
    for (const rate of model.rates)
      assert.deepEqual(
        Object.keys(rate),
        ['validFrom', 'validUntilExclusive', 'promptTokensAbove', 'usdPerMillionTokens'],
        model.id,
      );
});

test('catalog IDs, sources, limits, and rates are complete and unambiguous', () => {
  assert.equal(new Set(config.models.map(model => model.id)).size, config.models.length);
  assert.equal(config.models.length, 22);
  for (const model of config.models) {
    assert.ok(config.sources[model.pricingSource], `${model.id}: pricing source`);
    assert.ok(model.providerModelId && model.metadataKey);
    assert.ok(Number.isSafeInteger(model.metadata.max_input_tokens) && model.metadata.max_input_tokens > 0);
    assert.ok(Number.isSafeInteger(model.metadata.max_output_tokens) && model.metadata.max_output_tokens > 0);
    assert.ok(model.rates.length > 0);
    for (const rate of model.rates) {
      assert.ok(rate.usdPerMillionTokens.input > 0 && rate.usdPerMillionTokens.output > 0);
      assert.ok(
        rate.promptTokensAbove === null || (Number.isSafeInteger(rate.promptTokensAbove) && rate.promptTokensAbove > 0),
      );
      for (const date of [rate.validFrom, rate.validUntilExclusive]) {
        assert.ok(date === null || /^\d{4}-\d{2}-\d{2}$/.test(date));
      }
    }
    for (const date of ['2026-09-28', '2026-12-31', '2027-01-01']) {
      const active = model.rates.filter(
        rate =>
          (rate.validFrom === null || date >= rate.validFrom) &&
          (rate.validUntilExclusive === null || date < rate.validUntilExclusive),
      );
      assert.equal(
        active.filter(rate => rate.promptTokensAbove === null).length,
        1,
        `${model.id}: base rate on ${date}`,
      );
      assert.equal(
        new Set(active.map(rate => rate.promptTokensAbove)).size,
        active.length,
        `${model.id}: duplicate threshold`,
      );
    }
  }
});

test('current GPT, DeepSeek, and Grok provider IDs match the selected Azure deployments', () => {
  const ids = [
    'gpt-6-luna',
    'gpt-6-sol',
    'gpt-6-astra',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'grok-4-6',
    'grok-4.3',
  ];
  assert.deepEqual(
    ids.map(id => config.models.find(model => model.id === id)?.providerModelId),
    ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash', 'grok-4.6', 'grok-4.3'],
  );
  assert.equal(
    config.models.some(model => model.providerModelId.startsWith('grok-4-1-fast-')),
    false,
  );
});

test('GPT long-context tiers and the Gemini promotion retain their published boundaries', () => {
  for (const id of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']) {
    const model = config.models.find(candidate => candidate.id === id);
    assert.deepEqual(
      model.rates.map(rate => rate.promptTokensAbove),
      [null, 272000],
    );
  }
  const gemini = config.models.find(model => model.id === 'gemini-3-8-flash');
  assert.deepEqual(
    gemini.rates.map(rate => [
      rate.validFrom,
      rate.validUntilExclusive,
      rate.usdPerMillionTokens.input,
      rate.usdPerMillionTokens.output,
    ]),
    [
      [null, '2027-01-01', 0.75, 3.75],
      ['2027-01-01', null, 1.5, 7.5],
    ],
  );
});

test('Kimi provider IDs match Azure exactly and GLM has no pricing entries', () => {
  assert.deepEqual(
    config.models.filter(model => model.id.startsWith('kimi-')).map(model => [model.id, model.providerModelId]),
    [
      ['kimi-k2-6', 'Kimi-K2.6'],
      ['kimi-k2-7-code', 'Kimi-K2.7-Code'],
    ],
  );
  assert.equal(
    config.models.some(model => model.id.startsWith('glm-')),
    false,
  );
});
