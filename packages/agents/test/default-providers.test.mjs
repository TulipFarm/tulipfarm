import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferDecision, inferText, inferWithTools } from '../dist/inference.js';
import { prepareAgentAuthoringInference } from '../dist/authoring-assistance-inference.js';
import { isCompletionRequest, completionReply } from './native-fixture.mjs';

const routes = {
  openai: { provider: 'openai', endpoint: 'https://api.openai.com/', model: 'gpt-6-luna', apiKey: 'synthetic-key' },
  openaiResponses: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/',
    model: 'gpt-6-astra',
    apiKey: 'synthetic-key',
  },
  xai: { provider: 'xai', endpoint: 'https://api.x.ai/', model: 'grok-4.6', apiKey: 'synthetic-key' },
  google: {
    provider: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/',
    model: 'gemini-3.5-flash',
    apiKey: 'synthetic-key',
  },
};
const decisionInput = {
  prompt: 'Synthetic prompt only.',
  definition: { name: 'Synthetic agent', instructions: 'Answer.', tools: [] },
  scope: [],
};
const known = (input, output, cacheRead) => ({
  kind: 'known',
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
});

function chatBody(text, usage) {
  return { model: 'actual-model', choices: [{ finish_reason: 'stop', message: { content: text } }], usage };
}

/** Mocks fetch: records each request and answers with the next reply. */
function provider(t, replies) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), headers: options.headers, body });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    return typeof reply === 'function' ? reply(body) : Response.json(reply);
  });
  return requests;
}

for (const name of ['openai', 'xai'])
  test(`${name} sends chat completions to its own API with a bearer key`, async t => {
    const requests = provider(t, [
      chatBody('Direct answer.', {
        prompt_tokens: 13,
        completion_tokens: 7,
        total_tokens: 20,
        prompt_tokens_details: { cached_tokens: 3 },
      }),
    ]);
    const receipts = [];
    assert.equal(
      await inferText(routes[name], [{ role: 'user', text: 'hello' }], async value => receipts.push(value)),
      'Direct answer.',
    );
    const [request] = requests;
    assert.equal(request.url, `${routes[name].endpoint}v1/chat/completions`);
    assert.equal(request.headers.authorization, 'Bearer synthetic-key');
    assert.equal(request.headers['api-key'], undefined);
    assert.equal(request.body.model, routes[name].model);
    assert.equal('store' in request.body, false);
    assert.deepEqual(receipts, [known(10, 7, 3)]);
  });

test('openai gpt-6-astra uses the Responses API and meters cached input', async t => {
  const requests = provider(t, [
    {
      model: 'gpt-6-astra',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Astra answer.' }] }],
      usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49, input_tokens_details: { cached_tokens: 8 } },
    },
  ]);
  const result = await inferDecision(routes.openaiResponses, decisionInput);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].headers.authorization, 'Bearer synthetic-key');
  assert.equal(requests[0].body.store, false);
  assert.deepEqual(result.usage, known(32, 9, 8));
});

test('xai counts reasoning tokens reported outside completion tokens as output', async t => {
  provider(t, [
    chatBody('Grok answer.', {
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 37,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 12 },
    }),
  ]);
  const receipts = [];
  await inferText(routes.xai, [{ role: 'user', text: 'hello' }], async value => receipts.push(value));
  assert.deepEqual(receipts, [known(20, 17, 0)]);
});

for (const [name, status, body, reason] of [
  [
    'openai',
    401,
    { error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'x' } },
    'authentication',
  ],
  ['openai', 429, { error: { type: 'requests', code: 'rate_limit_exceeded', message: 'x' } }, 'rate-limit'],
  ['openai', 429, { error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'x' } }, 'quota'],
  ['openai', 400, { error: { code: 'context_length_exceeded', message: 'x' } }, 'context-overflow'],
  ['openai', 400, { error: { code: 'content_policy_violation', message: 'x' } }, 'refusal'],
  ['openai', 404, { error: { code: 'model_not_found', message: 'x' } }, 'configuration'],
  [
    'xai',
    400,
    { code: 'Client specified an invalid argument', error: 'Incorrect API key provided: xa***ey.' },
    'authentication',
  ],
  ['xai', 400, { code: 'Client specified an invalid argument', error: 'Unknown field: foo' }, 'invalid-request'],
  ['xai', 401, { code: 'unauthenticated', error: 'Incorrect API key provided' }, 'authentication'],
  [
    'xai',
    403,
    { code: 'permission denied', error: 'Your team has used all available credits or reached its spending limit.' },
    'quota',
  ],
  ['xai', 403, { code: 'permission denied', error: 'The model is not available to your team.' }, 'permission'],
  ['xai', 429, { code: 'Too many requests', error: 'Rate limit reached for requests per minute.' }, 'rate-limit'],
  ['xai', 429, { code: 'Too many requests', error: 'You have run out of credits.' }, 'quota'],
])
  test(`${name} HTTP ${status} ${JSON.stringify(body.error.code ?? body.code)} maps to ${reason}`, async t => {
    provider(t, [() => Response.json(body, { status })]);
    await assert.rejects(inferText(routes[name], [{ role: 'user', text: 'hello' }]), {
      message: `model-${reason}`,
    });
    const decision = await inferDecision(routes[name], decisionInput);
    assert.equal(decision.kind, 'failure');
    assert.equal(decision.reason, reason);
  });

const encoder = new TextEncoder();
function sse(chunks) {
  const bytes = encoder.encode(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(''));
  // Split mid-event so the reader must reassemble lines across reads.
  const parts = [bytes.slice(0, 17), bytes.slice(17, 120), bytes.slice(120)];
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index < parts.length) controller.enqueue(parts[index++]);
        else controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test('Gemini chat streams through streamGenerateContent and meters the final cumulative usage', async t => {
  const chunks = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Streamed ' }] } }], modelVersion: 'gemini-3.5-flash' },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini ' }] } }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 2, totalTokenCount: 32 },
    },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'answer.' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 30,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 6,
        cachedContentTokenCount: 10,
        totalTokenCount: 40,
      },
      responseId: 'gemini-stream',
    },
  ];
  const requests = provider(t, [
    body => (isCompletionRequest(body) ? Response.json(completionReply('google')) : sse(chunks)),
  ]);
  const updates = [];
  const usages = [];
  const result = await inferWithTools(
    routes.google,
    [{ role: 'user', text: 'Say hello.' }],
    () => assert.fail('No tool expected'),
    async () => async usage => usages.push(usage),
    false,
    null,
    { answerText: update => updates.push(update.text) },
  );
  assert.equal(result.text, 'Streamed Gemini answer.');
  assert.equal(
    requests[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse',
  );
  assert.equal(requests[0].headers['x-goog-api-key'], 'synthetic-key');
  assert.equal(requests[0].body.stream, undefined);
  assert.deepEqual(updates.at(-1), 'Streamed Gemini answer.');
  assert.ok(updates.length >= 2, 'the answer is published while it streams');
  assert.deepEqual(usages[0], known(20, 10, 10));
});

test('a Gemini stream that breaks off without valid chunks is an invalid response', async t => {
  provider(t, [
    () =>
      new Response(encoder.encode('data: {"candidates": [\r\n\r\n'), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  ]);
  await assert.rejects(
    inferWithTools(routes.google, [{ role: 'user', text: 'Say hello.' }], () => assert.fail('No tool expected')),
    /model-/,
  );
});

for (const [name, path, store] of [
  ['openai', 'v1/chat/completions', false],
  ['openaiResponses', 'v1/responses', false],
  ['xai', 'v1/chat/completions', undefined],
])
  test(`agent authoring sends ${name} text requests to ${path} and meters them`, async () => {
    const route = { ...routes[name], maxOutputTokens: 2048 };
    const requests = [];
    let metered;
    const result = await prepareAgentAuthoringInference(
      route,
      'No tools.',
      [{ role: 'user', content: 'Hello' }],
      8000,
      async (url, options) => {
        requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
        return Response.json(
          name === 'openaiResponses'
            ? {
                model: route.model,
                status: 'completed',
                output: [
                  { type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Improved.' }] },
                ],
                usage: {
                  input_tokens: 40,
                  output_tokens: 10,
                  total_tokens: 50,
                  input_tokens_details: { cached_tokens: 0 },
                },
              }
            : {
                ...chatBody('Improved.', { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 }),
                model: route.model,
              },
        );
      },
    ).run(new AbortController().signal, value => {
      metered = value;
    });
    assert.deepEqual(result, { text: 'Improved.', actualModel: route.model });
    assert.equal(requests[0].url, `${route.endpoint}${path}`);
    assert.equal(requests[0].headers.authorization, 'Bearer synthetic-key');
    assert.equal(requests[0].body.store, store);
    assert.deepEqual(metered, known(40, 10, 0));
  });

test('agent authoring reports an xAI wrong key as an authentication failure', async () => {
  const request = prepareAgentAuthoringInference(
    { ...routes.xai, maxOutputTokens: 2048 },
    'No tools.',
    [{ role: 'user', content: 'Hello' }],
    8000,
    async () =>
      Response.json(
        { code: 'Client specified an invalid argument', error: 'Incorrect API key provided: xa***ey.' },
        { status: 400 },
      ),
  );
  await assert.rejects(
    request.run(new AbortController().signal, () => {}),
    error => error.code === 'provider-authentication',
  );
});
