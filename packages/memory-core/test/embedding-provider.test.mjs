import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmbeddingProvider, prepareEmbeddingInputs } from '../dist/embeddings/provider.js';

const profile = Object.freeze({
  id: 'test-profile',
  model: 'test-model',
  dimensions: 3,
  maxInputTokens: 8,
  maxBatchInputs: 2,
  maxBatchTokens: 10,
  maxInputBytes: 64,
});
const config = {
  kind: 'enabled',
  provider: 'openai-compatible',
  endpoint: 'https://example.invalid/v1/',
  apiKey: 'synthetic-key',
  requestModel: 'test-deployment',
  profile,
};
const envelope = () => ({
  model: profile.model,
  data: [
    { index: 1, embedding: [0, 1, 0] },
    { index: 0, embedding: [1, 0, 0] },
  ],
  usage: { prompt_tokens: 2, total_tokens: 2 },
});

test('core provider uses the explicit profile without importing host configuration', async () => {
  const embed = createEmbeddingProvider(config, profile, {
    fetch: async (url, init) => {
      assert.equal(url, 'https://example.invalid/v1/embeddings');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(JSON.parse(init.body), {
        model: 'test-deployment',
        input: ['hello', 'world'],
        dimensions: 3,
        encoding_format: 'float',
      });
      return Response.json(envelope(), { headers: { 'x-request-id': 'test-request' } });
    },
  });
  assert.deepEqual(await embed({ inputs: ['hello', 'world'] }), {
    dispatch: 'dispatched',
    inputTokensUpperBound: 2,
    requestId: 'test-request',
    usage: { kind: 'known', inputTokens: 2, totalTokens: 2, exceedsUpperBound: false },
    result: {
      kind: 'success',
      model: 'test-model',
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
      ],
    },
  });
});

test('input preparation applies the supplied byte, token, batch and count limits', () => {
  const prepared = prepareEmbeddingInputs(['hello world'], profile);
  assert.equal(prepared.inputTokensUpperBound, 2);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.inputs), true);
  assert.equal(prepareEmbeddingInputs([' x'.repeat(8)], profile).inputTokensUpperBound, 8);
  assert.equal(prepareEmbeddingInputs(Array(2).fill(' x'.repeat(5)), profile).inputTokensUpperBound, 10);
  const byteBoundary = `${' '.repeat(63)}x`;
  const beyondByteBoundary = `${' '.repeat(64)}x`;
  assert.equal(Buffer.byteLength(byteBoundary), 64);
  assert.equal(Buffer.byteLength(beyondByteBoundary), 65);
  assert.doesNotThrow(() => prepareEmbeddingInputs([byteBoundary], profile));
  assert.doesNotThrow(() => prepareEmbeddingInputs([beyondByteBoundary], { ...profile, maxInputBytes: 65 }));
  for (const inputs of [
    [],
    [''],
    [' '],
    ['\ud800'],
    [beyondByteBoundary],
    Array(3).fill('hello'),
    [' x'.repeat(9)],
    Array(2).fill(' x'.repeat(6)),
  ])
    assert.throws(() => prepareEmbeddingInputs(inputs, profile), { message: 'Invalid knowledge embedding input' });
});

test('disabled, cancelled and invalid requests cannot dispatch', async () => {
  const fetch = async () => assert.fail('request must not dispatch');
  const disabled = createEmbeddingProvider({ kind: 'disabled' }, profile, { fetch });
  const enabled = createEmbeddingProvider(config, profile, { fetch });
  for (const [embed, input, code] of [
    [disabled, { inputs: ['hello'] }, 'disabled'],
    [enabled, { inputs: ['hello'], signal: AbortSignal.abort() }, 'cancelled'],
    [enabled, { inputs: [''] }, 'invalid_input'],
  ]) {
    const result = await embed(input);
    assert.equal(result.dispatch, 'undispatched');
    assert.deepEqual(result.result, { kind: 'error', code });
    assert.deepEqual(result.usage, { kind: 'unknown', reason: 'undispatched' });
  }
});

test('response validation uses the supplied model and dimensions and retains known usage', async () => {
  for (const [mutate, code] of [
    [
      body => {
        body.model = 'other';
      },
      'invalid_model',
    ],
    [
      body => {
        body.data[0].embedding.push(0);
      },
      'invalid_vectors',
    ],
    [
      body => {
        body.data[0].index = 0;
      },
      'invalid_vectors',
    ],
    [
      body => {
        body.usage = { prompt_tokens: 3, total_tokens: 3 };
      },
      'usage_exceeds_bound',
    ],
  ]) {
    const body = envelope();
    mutate(body);
    const embed = createEmbeddingProvider(config, profile, { fetch: async () => Response.json(body) });
    const result = await embed({ inputs: ['hello', 'world'] });
    assert.equal(result.dispatch, 'dispatched');
    assert.equal(result.usage.kind, 'known');
    assert.deepEqual(result.result, { kind: 'error', code });
  }
});
