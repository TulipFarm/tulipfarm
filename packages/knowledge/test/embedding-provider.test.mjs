import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKnowledgeEmbeddingsConfig } from '@tulipfarm/config';
import {
  createKnowledgeEmbeddingProvider,
  prepareKnowledgeEmbeddingInputs,
} from '../dist/internal/embedding-provider.js';

const config = parseKnowledgeEmbeddingsConfig({
  KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
  AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
  AZURE_FOUNDRY_API_KEY: 'synthetic-secret',
});
const vector = value => Array(1536).fill(value);
const body = () => ({
  model: 'text-embedding-3-large',
  data: [
    { index: 1, embedding: vector(0.2) },
    { index: 0, embedding: vector(0.1) },
  ],
  usage: { prompt_tokens: 2, total_tokens: 2 },
});
const response = value => new Response(JSON.stringify(value), { headers: { 'apim-request-id': 'test-request-123' } });

test('final input tokenizer counts verbatim context and treats special spellings as ordinary text', () => {
  assert.equal(prepareKnowledgeEmbeddingInputs(['hello world']).inputTokensUpperBound, 2);
  assert.equal(prepareKnowledgeEmbeddingInputs(['<|endoftext|>']).inputTokensUpperBound, 7);
  const prepared = prepareKnowledgeEmbeddingInputs(['# Title\n\nhello world']);
  assert.deepEqual(prepared.inputs, ['# Title\n\nhello world']);
  assert.equal(prepared.inputTokensUpperBound, 5);
  assert.match(prepared.inputHash, /^[a-f0-9]{64}$/);
  assert.notEqual(prepared.inputHash, prepareKnowledgeEmbeddingInputs(['hello world']).inputHash);
  assert.throws(() => prepared.inputs.push('extra'), TypeError);
});

test('one request returns indexed vectors in input order with known usage', async () => {
  let calls = 0;
  const embed = createKnowledgeEmbeddingProvider(config, {
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://example.services.ai.azure.com/openai/v1/embeddings');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['api-key'], 'synthetic-secret');
      assert.deepEqual(JSON.parse(init.body), {
        model: 'text-embedding-3-large',
        input: ['hello', 'world'],
        dimensions: 1536,
        encoding_format: 'float',
      });
      return response(body());
    },
  });
  assert.deepEqual(await embed({ inputs: ['hello', 'world'] }), {
    dispatch: 'dispatched',
    inputTokensUpperBound: 2,
    requestId: 'test-request-123',
    usage: { kind: 'known', inputTokens: 2, totalTokens: 2, exceedsUpperBound: false },
    result: { kind: 'success', model: 'text-embedding-3-large', vectors: [vector(0.1), vector(0.2)] },
  });
  assert.equal(calls, 1);
});

test('OpenAI-compatible endpoints receive a bearer key and the configured request model', async () => {
  const compatible = parseKnowledgeEmbeddingsConfig({
    KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
    KNOWLEDGE_EMBEDDINGS_PROVIDER: 'openai-compatible',
    KNOWLEDGE_EMBEDDINGS_BASE_URL: 'https://gateway.example/v1',
    KNOWLEDGE_EMBEDDINGS_API_KEY: 'synthetic-bearer',
    KNOWLEDGE_EMBEDDINGS_MODEL: 'openai/text-embedding-3-large',
  });
  const embed = createKnowledgeEmbeddingProvider(compatible, {
    fetch: async (url, init) => {
      assert.equal(url, 'https://gateway.example/v1/embeddings');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer synthetic-bearer');
      assert.equal(init.headers['api-key'], undefined);
      assert.deepEqual(JSON.parse(init.body), {
        model: 'openai/text-embedding-3-large',
        input: ['hello', 'world'],
        dimensions: 1536,
        encoding_format: 'float',
      });
      return new Response(JSON.stringify(body()), { headers: { 'x-request-id': 'gateway-request-1' } });
    },
  });
  const result = await embed({ inputs: ['hello', 'world'] });
  assert.equal(result.requestId, 'gateway-request-1');
  assert.deepEqual(result.result, {
    kind: 'success',
    model: 'text-embedding-3-large',
    vectors: [vector(0.1), vector(0.2)],
  });
  const otherModel = createKnowledgeEmbeddingProvider(compatible, {
    fetch: async () => response({ ...body(), model: 'nomic-embed-text' }),
  });
  assert.deepEqual((await otherModel({ inputs: ['hello', 'world'] })).result, { kind: 'error', code: 'invalid_model' });
});

test('invalid inputs, disabled config and pre-dispatch cancellation never reach Azure', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return response(body());
  };
  const embed = createKnowledgeEmbeddingProvider(config, { fetch });
  for (const inputs of [
    [],
    [''],
    ['  '],
    ['\ud800'],
    [null],
    Array(33).fill('hi'),
    ['a'.repeat(131073)],
    [' x'.repeat(8193)],
    Array(3).fill(' x'.repeat(6000)),
  ]) {
    assert.deepEqual(await embed({ inputs }), {
      dispatch: 'undispatched',
      inputTokensUpperBound: 0,
      requestId: null,
      usage: { kind: 'unknown', reason: 'undispatched' },
      result: { kind: 'error', code: 'invalid_input' },
    });
  }
  const disabled = createKnowledgeEmbeddingProvider({ kind: 'disabled' }, { fetch });
  assert.deepEqual((await disabled({ inputs: ['hello'] })).result, { kind: 'error', code: 'disabled' });
  assert.deepEqual((await embed({ inputs: ['hello'], signal: AbortSignal.abort() })).result, {
    kind: 'error',
    code: 'cancelled',
  });
  assert.equal(calls, 0);
});

test('known usage survives malformed model, dimensions, coordinates, count, and indices', async () => {
  for (const [mutate, code] of [
    [
      value => {
        value.model = 'wrong';
      },
      'invalid_model',
    ],
    [
      value => {
        delete value.data;
      },
      'invalid_vectors',
    ],
    [
      value => {
        value.data.pop();
      },
      'invalid_vectors',
    ],
    [
      value => {
        value.data[0].index = 0;
      },
      'invalid_vectors',
    ],
    [
      value => {
        value.data[0].index = 2;
      },
      'invalid_vectors',
    ],
    [
      value => {
        value.data[0].index = 0.5;
      },
      'invalid_vectors',
    ],
    [
      value => {
        value.data[0].embedding.pop();
      },
      'invalid_vectors',
    ],
    [
      value => {
        value.data[0].embedding[0] = Infinity;
      },
      'invalid_vectors',
    ],
  ]) {
    const value = body();
    mutate(value);
    const embed = createKnowledgeEmbeddingProvider(config, { fetch: async () => response(value) });
    const result = await embed({ inputs: ['hello', 'world'] });
    assert.deepEqual(result.usage, { kind: 'known', inputTokens: 2, totalTokens: 2, exceedsUpperBound: false });
    assert.deepEqual(result.result, { kind: 'error', code });
  }
});

test('missing or inconsistent usage cannot publish vectors', async () => {
  for (const usage of [
    undefined,
    {},
    { prompt_tokens: 1, total_tokens: 2 },
    { prompt_tokens: -1, total_tokens: -1 },
    { prompt_tokens: 0.5, total_tokens: 0.5 },
    { prompt_tokens: '2', total_tokens: '2' },
    { prompt_tokens: 1e20, total_tokens: 1e20 },
  ]) {
    const embed = createKnowledgeEmbeddingProvider(config, { fetch: async () => response({ ...body(), usage }) });
    const result = await embed({ inputs: ['hello', 'world'] });
    assert.equal(result.usage.kind, 'unknown');
    assert.deepEqual(result.result, { kind: 'error', code: 'invalid_usage' });
  }
});

test('observed usage above the reservation remains known and visibly blocks publication', async () => {
  const embed = createKnowledgeEmbeddingProvider(config, {
    fetch: async () => response({ ...body(), usage: { prompt_tokens: 3, total_tokens: 3 } }),
  });
  const result = await embed({ inputs: ['hello', 'world'] });
  assert.deepEqual(result.usage, { kind: 'known', inputTokens: 3, totalTokens: 3, exceedsUpperBound: true });
  assert.deepEqual(result.result, { kind: 'error', code: 'usage_exceeds_bound' });
});

test('HTTP errors preserve known usage and never expose response text or retry', async () => {
  let calls = 0;
  const embed = createKnowledgeEmbeddingProvider(config, {
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ ...body(), error: 'synthetic-secret and private input' }), {
        status: 429,
        headers: { 'apim-request-id': 'private request content' },
      });
    },
  });
  const result = await embed({ inputs: ['hello', 'world'] });
  assert.deepEqual(result.usage, { kind: 'known', inputTokens: 2, totalTokens: 2, exceedsUpperBound: false });
  assert.deepEqual(result.result, { kind: 'error', code: 'http' });
  assert.equal(result.requestId, null);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|private/);
  assert.equal(calls, 1);
});

test('transport, timeout, body timeout, cancellation, and invalid JSON retain unknown dispatched outcomes', async () => {
  const cancelled = new AbortController();
  const scenarios = [
    {
      fetch: async () => {
        throw new Error('synthetic-secret');
      },
      code: 'transport',
    },
    { fetch: async () => new Promise(() => {}), code: 'timeout' },
    { fetch: async () => new Response(new ReadableStream({ start() {} })), code: 'timeout' },
    {
      fetch: async () => {
        cancelled.abort();
        return new Promise(() => {});
      },
      signal: cancelled.signal,
      code: 'cancelled',
    },
    { fetch: async () => new Response('synthetic-secret'), code: 'invalid_json' },
  ];
  for (const scenario of scenarios) {
    const embed = createKnowledgeEmbeddingProvider(config, { fetch: scenario.fetch, timeoutMs: 10 });
    const result = await embed({ inputs: ['hello'], signal: scenario.signal });
    assert.equal(result.dispatch, 'dispatched');
    assert.equal(result.usage.kind, 'unknown');
    assert.deepEqual(result.result, { kind: 'error', code: scenario.code });
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  }
});
