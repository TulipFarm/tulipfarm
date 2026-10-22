import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateUsageCost, reserveModelCost } from '../src/model-cost.ts';

const quote = {
  modelId: 'test',
  pricingRevision: 'test',
  date: '2026-09-29',
  maxInputTokens: 100,
  maxOutputTokens: 20,
  rates: [
    {
      validFrom: null,
      validUntilExclusive: null,
      promptTokensAbove: null,
      usdPerMillionTokens: {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 3,
      },
    },
  ],
};
test('reservation bounds cache costs and exact usage never rounds individual requests', () => {
  assert.equal(reserveModelCost(quote), '500000000');
  assert.deepEqual(
    calculateUsageCost({
      ...quote,
      usage: {
        kind: 'known',
        tokens: {
          input: 10,
          output: 2,
          cacheRead: 10,
          cacheWrite: 5,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        },
      },
    }),
    {
      kind: 'known',
      providerPicoUsd: '57000000',
      pricingRevision: 'test',
      modelId: 'test',
      date: '2026-09-29',
      promptTokensAbove: null,
    },
  );
  assert.deepEqual(
    calculateUsageCost({
      ...quote,
      usage: { kind: 'unknown', reason: 'missing' },
    }),
    {
      kind: 'unknown',
      reason: 'missing',
    },
  );
});
