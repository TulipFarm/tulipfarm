import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { inferChatTitle, inferWithTools, openAiUsage } from '../dist/inference.js';
import { selectReply } from './native-fixture.mjs';

// Synthetic streams in the Chat Completions chunk format each hosted catalog model returns through Azure AI Foundry.
const encoder = new TextEncoder();
const azure = model => ({
  provider: 'azure',
  endpoint: 'https://synthetic.services.ai.azure.com/',
  model,
  auth: { kind: 'api-key', value: 'synthetic-key' },
});
const deepseek = azure('DeepSeek-V4-Flash');
const known = (input, output, cacheRead = 0) => ({
  kind: 'known',
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
});
const chatCompletions = { api: 'chat-completions', reasoningTokensInOutput: false };
const reasoningInOutput = { api: 'chat-completions', reasoningTokensInOutput: true };

/** DeepSeek's documented usage object: details plus its own cache hit and miss counts. */
const deepseekUsage = {
  prompt_tokens: 281,
  completion_tokens: 75,
  total_tokens: 356,
  prompt_tokens_details: { cached_tokens: 256 },
  prompt_cache_hit_tokens: 256,
  prompt_cache_miss_tokens: 25,
  completion_tokens_details: { reasoning_tokens: 60 },
};

for (const [name, capabilities, usage, expected] of [
  ['DeepSeek counts reasoning inside completion_tokens', chatCompletions, deepseekUsage, known(25, 75, 256)],
  [
    'DeepSeek cache hits without prompt_tokens_details',
    chatCompletions,
    { ...deepseekUsage, prompt_tokens_details: null },
    known(25, 75, 256),
  ],
  [
    'null detail objects and counts read as zero',
    chatCompletions,
    {
      prompt_tokens: 13,
      completion_tokens: 7,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: null },
      completion_tokens_details: null,
    },
    known(13, 7),
  ],
  [
    'Grok reports reasoning outside completion_tokens, and the total says so',
    reasoningInOutput,
    {
      prompt_tokens: 13,
      completion_tokens: 7,
      total_tokens: 25,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
    known(10, 12, 3),
  ],
  [
    'reasoning outside completion_tokens is billed even when the catalog does not flag it',
    chatCompletions,
    { prompt_tokens: 13, completion_tokens: 7, total_tokens: 25, completion_tokens_details: { reasoning_tokens: 5 } },
    known(13, 12),
  ],
  [
    'reasoning inside completion_tokens is not billed twice when the catalog flags it',
    reasoningInOutput,
    { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } },
    known(13, 7),
  ],
  [
    'Kimi without a total falls back to the catalog flag',
    chatCompletions,
    { prompt_tokens: 13, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 5 } },
    known(13, 7),
  ],
  [
    'Responses usage with null details',
    { api: 'responses', reasoningTokensInOutput: false },
    { input_tokens: 13, output_tokens: 7, total_tokens: 20, input_tokens_details: null },
    known(13, 7),
  ],
])
  test(`usage: ${name}`, () => {
    assert.deepEqual(openAiUsage(capabilities, { usage }), expected);
  });

for (const [name, body] of [
  ['no usage', {}],
  ['a total that adds up no way', { usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 21 } }],
  [
    'more cache hits than prompt tokens',
    { usage: { prompt_tokens: 13, completion_tokens: 7, prompt_cache_hit_tokens: 14 } },
  ],
  ['fractional counts', { usage: { prompt_tokens: 13, completion_tokens: 1.5, total_tokens: 14.5 } }],
])
  test(`usage: ${name} stays unknown`, () => {
    assert.deepEqual(openAiUsage(chatCompletions, body), { kind: 'unknown' });
  });

const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'DeepSeek-V4-Flash' };
const filterChunk = { id: '', object: '', created: 0, model: '', choices: [], prompt_filter_results: [] };
const content = (text, extra = {}) => ({
  ...base,
  choices: [{ index: 0, delta: { content: text, reasoning_content: null }, logprobs: null, finish_reason: null }],
  usage: null,
  ...extra,
});
const finalContent = usage => ({
  ...base,
  choices: [{ index: 0, delta: { content: '', reasoning_content: null }, logprobs: null, finish_reason: 'stop' }],
  usage,
});
const usageOnly = usage => ({ ...base, choices: [], usage });
const usage = {
  prompt_tokens: 40,
  completion_tokens: 3,
  total_tokens: 43,
  prompt_tokens_details: { cached_tokens: 0 },
};
const event = chunk => encoder.encode(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
const stream = chunks =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of [...chunks, '[DONE]']) controller.enqueue(event(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
const completionCheck = body => JSON.stringify(body.messages ?? []).includes('Check whether a proposed chat reply');

/** Answers the reply's model call with `reply()` and the completion check as a separate, non-streamed call. */
function provider(t, reply) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (completionCheck(body))
      return Response.json(selectReply('azure', { status: 'completed', reason: 'The synthetic reply is complete.' }));
    requests.push(body);
    return reply();
  });
  return requests;
}

const spans = new InMemorySpanExporter();
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 });
const sdk = new NodeSDK({
  autoDetectResources: false,
  spanProcessors: [new SimpleSpanProcessor(spans)],
  metricReader: reader,
});
sdk.start();
after(() => sdk.shutdown());

/** The process's telemetry, with this test's log lines. Tests use distinct deployment names to keep metrics apart. */
function telemetry(t) {
  const logs = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.startsWith('{"level":')) {
      logs.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  return {
    logs,
    spans: model => spans.getFinishedSpans().filter(span => span.attributes['gen_ai.request.model'] === model),
    async metric(name, model) {
      await reader.forceFlush();
      const all = exporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics));
      const points = all.findLast(metric => metric.descriptor.name === name)?.dataPoints ?? [];
      return points.filter(point => point.attributes['gen_ai.request.model'] === model);
    },
  };
}

async function reply(route = deepseek) {
  const metered = [];
  const updates = [];
  const result = await inferWithTools(
    route,
    [{ role: 'user', text: 'Hi' }],
    () => assert.fail('No tool expected'),
    async () => async value => metered.push(value),
    false,
    null,
    { answerText: update => updates.push(update) },
  );
  return { result, metered, updates };
}

test('streamed DeepSeek usage on the last content chunk is metered, counted and recorded as tokens', async t => {
  const otel = telemetry(t);
  const requests = provider(t, () =>
    stream([
      filterChunk,
      content('', { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
      content('Hello'),
      content(' there'),
      finalContent(deepseekUsage),
    ]),
  );
  const { result, metered } = await reply();
  assert.deepEqual(result, { text: 'Hello there' });
  assert.equal(requests[0].stream, true);
  assert.deepEqual(requests[0].stream_options, { include_usage: true });
  assert.deepEqual(metered, [known(25, 75, 256)]);
  const tokens = await otel.metric('gen_ai_client_tokens', 'DeepSeek-V4-Flash');
  assert.deepEqual(Object.fromEntries(tokens.map(point => [point.attributes.token_type, point.value])), {
    input: 281,
    output: 75,
  });
  const usageCounts = await otel.metric('gen_ai_model_usage', 'DeepSeek-V4-Flash');
  assert.ok(usageCounts.length > 0);
  assert.ok(usageCounts.every(point => point.attributes.model_usage === 'reported'));
  assert.ok(usageCounts.every(point => point.attributes['gen_ai.provider.name'] === 'azure'));
  assert.equal(otel.logs.filter(log => log['error.type'] === 'usage-unknown').length, 0);
});

for (const [name, chunks] of [
  ['a separate usage chunk with no choices', [content('Hello'), finalContent(null), usageOnly(usage)]],
  ['usage followed by an empty usage object', [content('Hello'), finalContent(usage), usageOnly({})]],
  [
    'usage followed by a partial usage object with null counts',
    [content('Hello'), finalContent(usage), usageOnly({ prompt_tokens: null, completion_tokens_details: null })],
  ],
  [
    'null usage details',
    [
      content('Hello'),
      finalContent({ ...usage, prompt_tokens_details: null, completion_tokens_details: { reasoning_tokens: null } }),
    ],
  ],
])
  test(`streamed usage survives ${name}`, async t => {
    provider(t, () => stream(chunks));
    const { result, metered } = await reply();
    assert.deepEqual(result, { text: 'Hello' });
    assert.deepEqual(metered, [known(40, 3)]);
  });

test('streamed Grok usage bills reasoning tokens reported outside completion_tokens', async t => {
  provider(t, () =>
    stream([
      { ...content('Hi'), model: 'grok-4.6' },
      {
        ...finalContent({
          prompt_tokens: 40,
          completion_tokens: 3,
          total_tokens: 63,
          prompt_tokens_details: { cached_tokens: 8 },
          completion_tokens_details: { reasoning_tokens: 20 },
        }),
        model: 'grok-4.6',
      },
    ]),
  );
  const { metered } = await reply(azure('grok-4.6'));
  assert.deepEqual(metered, [known(32, 23, 8)]);
});

test('a stream with no usage is metered unknown, counted and logged with its reason', async t => {
  const otel = telemetry(t);
  provider(t, () => stream([content('Hello'), finalContent(null)]));
  const { result, metered } = await reply(azure('deepseek-without-usage'));
  assert.deepEqual(result, { text: 'Hello' });
  assert.deepEqual(metered, [{ kind: 'unknown' }]);
  assert.deepEqual(await otel.metric('gen_ai_client_tokens', 'deepseek-without-usage'), []);
  const usageCounts = await otel.metric('gen_ai_model_usage', 'deepseek-without-usage');
  assert.deepEqual(
    usageCounts.map(point => [point.attributes.model_usage, point.attributes.outcome, point.value]),
    [['unknown', 'success', 1]],
  );
  const warnings = otel.logs.filter(log => log['error.type'] === 'usage-unknown');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warn');
  assert.equal(warnings[0].operation, 'chat.model-usage');
  assert.equal(warnings[0]['usage.unknown_reason'], 'missing');
  assert.equal(warnings[0]['gen_ai.request.model'], 'deepseek-without-usage');
});

test('usage that does not add up is logged as invalid with only its field names and counts', async t => {
  const otel = telemetry(t);
  provider(t, () =>
    stream([content('Hello'), finalContent({ prompt_tokens: 40, completion_tokens: 3, total_tokens: 99, note: 'x' })]),
  );
  const { metered } = await reply(azure('deepseek-invalid-usage'));
  assert.deepEqual(metered, [{ kind: 'unknown' }]);
  const [warning] = otel.logs.filter(log => log['error.type'] === 'usage-unknown');
  assert.equal(warning['usage.unknown_reason'], 'invalid');
  assert.equal(warning['usage.shape'], 'prompt_tokens=40,completion_tokens=3,total_tokens=99,note=string');
});

test('the first streamed chunk is forwarded and timed before the stream ends', async t => {
  const otel = telemetry(t);
  let controller;
  let dispatched;
  const fetched = new Promise(resolve => {
    dispatched = resolve;
  });
  provider(t, () => {
    dispatched();
    return new Response(
      new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const metered = [];
  const updates = [];
  const model = 'deepseek-first-token';
  const pending = inferWithTools(
    azure(model),
    [{ role: 'user', text: 'Hi' }],
    () => assert.fail('No tool expected'),
    async () => async value => metered.push(value),
    false,
    null,
    { answerText: update => updates.push(update) },
  );
  await fetched;
  controller.enqueue(event(filterChunk));
  controller.enqueue(
    event(content('', { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })),
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await otel.metric('gen_ai_client_time_to_first_token', model), [], 'no content yet');
  controller.enqueue(event(content('Hel')));
  for (let tries = 0; tries < 100 && updates.length === 0; tries++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates, [{ step: 0, text: 'Hel' }], 'the first chunk reached the reply before the stream ended');
  const [firstToken] = await otel.metric('gen_ai_client_time_to_first_token', model);
  assert.equal(firstToken.value.count, 1, 'time to first token was recorded at the first content chunk');
  assert.deepEqual(otel.spans(model), [], 'the model call is still open');
  await new Promise(resolve => setTimeout(resolve, 150));
  controller.enqueue(event(content('lo')));
  controller.enqueue(event(finalContent(usage)));
  controller.enqueue(event('[DONE]'));
  controller.close();
  assert.deepEqual(await pending, { text: 'Hello' });
  assert.deepEqual(metered, [known(40, 3)]);
  assert.deepEqual(updates, [
    { step: 0, text: 'Hel' },
    { step: 0, text: 'Hello' },
  ]);
  const [ttft] = await otel.metric('gen_ai_client_time_to_first_token', model);
  const [call] = otel.spans(model);
  const callSeconds = call.duration[0] + call.duration[1] / 1e9;
  assert.equal(ttft.value.count, 1);
  assert.ok(
    ttft.value.sum + 0.1 < callSeconds,
    `time to first token ${ttft.value.sum}s is well before the end of the ${callSeconds}s call`,
  );
});

test('a streamed title reports DeepSeek usage', async t => {
  provider(t, () => stream([content('Greeting'), finalContent(deepseekUsage)]));
  const metered = [];
  assert.equal(await inferChatTitle(deepseek, 'Hello', async () => async value => metered.push(value)), 'Greeting');
  assert.deepEqual(metered, [known(25, 75, 256)]);
});
