import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pricedUsage } from '../src/reply-session.ts';

const quote = {
  modelId: 'copilot-claude-sonnet-5',
  pricingRevision: 'test',
  date: '2026-09-29',
  maxInputTokens: 100,
  maxOutputTokens: 20,
  rates: [
    {
      validFrom: null,
      validUntilExclusive: null,
      promptTokensAbove: null,
      usdPerMillionTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
};
const tokens = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

function logs(t) {
  const records = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.startsWith('{"level":')) {
      records.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  return records;
}

test('a plan reply whose summed usage exceeds the route limits is priced as reported and logged, not failed', t => {
  const records = logs(t);
  const cost = pricedUsage({ ...quote, usage: { kind: 'known', tokens: tokens(5000, 400) } }, 0n, {
    provider: 'copilot',
    model: 'claude-sonnet-5',
  });
  assert.deepEqual(cost, {
    kind: 'known',
    providerPicoUsd: '0',
    pricingRevision: 'test',
    modelId: 'copilot-claude-sonnet-5',
    date: '2026-09-29',
    promptTokensAbove: null,
  });
  const [warning] = records.filter(record => record.operation === 'chat.usage-cost');
  assert.equal(warning.level, 'warn');
  assert.equal(warning.outcome, 'over_limit');
  assert.equal(warning['gen_ai.provider.name'], 'copilot');
  assert.equal(warning['billing.source'], 'plan');
  assert.equal(warning['gen_ai.usage.input_tokens'], 5000);
  assert.equal(warning['gen_ai.usage.output_tokens'], 400);
});

test('usage within the bound is priced exactly without a warning', t => {
  const records = logs(t);
  const cost = pricedUsage({ ...quote, usage: { kind: 'known', tokens: tokens(10, 2) } }, 7n, {
    provider: 'copilot',
    model: 'claude-sonnet-5',
  });
  assert.equal(cost.providerPicoUsd, '0');
  assert.equal(records.filter(record => record.operation === 'chat.usage-cost').length, 0);
});

test('a hosted call on a day without a price is charged its held worst case', t => {
  logs(t);
  const expired = [{ ...quote.rates[0], validUntilExclusive: '2026-01-01' }];
  const cost = pricedUsage({ ...quote, rates: expired, usage: { kind: 'known', tokens: tokens(10, 2) } }, 900n, {
    provider: 'xai',
    model: 'grok-4.3-fast',
  });
  assert.equal(cost.providerPicoUsd, '900');
});

const grok = {
  ...quote,
  modelId: 'grok-fast',
  maxInputTokens: 200000,
  maxOutputTokens: 8192,
  rates: [
    {
      validFrom: null,
      validUntilExclusive: null,
      promptTokensAbove: null,
      usdPerMillionTokens: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    },
  ],
};

test('a call cut off at its output limit whose reasoning tokens exceed the limit is charged its reported tokens', t => {
  const records = logs(t);
  const worstCase = 178_000_000_000n;
  const usage = { ...tokens(3336, 8247), cacheRead: 30000 };
  const cost = pricedUsage({ ...grok, usage: { kind: 'known', tokens: usage } }, worstCase, {
    provider: 'azure',
    model: 'grok-4.3',
  });
  assert.equal(cost.providerPicoUsd, String(3336 * 1_250_000 + 30000 * 200_000 + 8247 * 2_500_000));
  const [warning] = records.filter(record => record.operation === 'chat.usage-cost');
  assert.equal(warning.outcome, 'over_limit');
});

test('reported usage priced above the held worst case is charged the worst case', t => {
  logs(t);
  const cost = pricedUsage({ ...grok, usage: { kind: 'known', tokens: tokens(3336, 8247) } }, 1000n, {
    provider: 'azure',
    model: 'grok-4.3',
  });
  assert.equal(cost.providerPicoUsd, '1000');
});
