import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { calculateUsageCost, legacyModels, shippedModelCatalogPath } from '@tulipfarm/config';
import { createMemoryRouteHealth } from '@tulipfarm/agents/chat';
import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import { conversationModel } from '../src/conversation-model.ts';
import { chatTitleModel } from '../src/conversation-activities.ts';
import { respondToConversation } from '../src/conversation-responder.ts';
import { isCompletionRequest } from './native-chat-fixture.mjs';

// One provider credential at a time: its families must run chat (streamed), titles and tasks against that provider's own API,
// metered at that provider's catalog price. The provider is a local HTTP server; only the outbound origin is rewritten.
const azureEndpoint = 'https://synthetic.services.ai.azure.com/';
const providers = {
  anthropic: { env: { ANTHROPIC_API_KEY: 'anthropic-key' }, origin: 'https://api.anthropic.com/' },
  openai: { env: { OPENAI_API_KEY: 'openai-key' }, origin: 'https://api.openai.com/' },
  xai: { env: { XAI_API_KEY: 'xai-key' }, origin: 'https://api.x.ai/' },
  google: { env: { GEMINI_API_KEY: 'gemini-key' }, origin: 'https://generativelanguage.googleapis.com/' },
  azure: {
    env: { AZURE_FOUNDRY_API_KEY: 'azure-key', AZURE_FOUNDRY_ENDPOINT: azureEndpoint },
    origin: azureEndpoint,
  },
};
const catalogFamilies = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8')).models.map(model => model.id);
const recommended = {
  anthropic: ['claude-haiku', 'claude-sonnet', 'claude-opus', 'claude-fable'],
  openai: ['gpt-luna', 'gpt-sol', 'gpt-astra'],
  xai: ['grok', 'grok-fast'],
  google: ['gemini-flash', 'gemini-pro'],
  azure: [
    'gpt-luna',
    'gpt-sol',
    'gpt-astra',
    'deepseek-pro',
    'deepseek-flash',
    'grok',
    'grok-fast',
    'kimi',
    'kimi-code',
  ],
};
const tokens = { input: 1000, output: 500 };
const titleText = 'Quarterly plan review';
const answerFragments = ['Your plan ', 'looks ', 'complete.'];

function formatOf(path) {
  if (path.endsWith('/v1/messages')) return 'anthropic';
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith('/responses')) return 'responses';
  if (/:(stream)?[gG]enerateContent$/.test(path)) return 'google';
  throw new Error(`Unexpected provider path ${path}`);
}

/** A reply in the provider's non-streaming shape: plain text, or one forced `select_action` call. */
function reply(format, model, { text, select }) {
  const args = select && JSON.stringify(select);
  switch (format) {
    case 'anthropic':
      return {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model,
        stop_reason: select ? 'tool_use' : 'end_turn',
        content: select
          ? [{ type: 'tool_use', id: 'toolu_1', name: 'select_action', input: select }]
          : [{ type: 'text', text }],
        usage: {
          input_tokens: tokens.input,
          output_tokens: tokens.output,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    case 'chat':
      return {
        model,
        choices: [
          {
            index: 0,
            finish_reason: select ? 'tool_calls' : 'stop',
            message: select
              ? {
                  content: null,
                  tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'select_action', arguments: args } },
                  ],
                }
              : { content: text },
          },
        ],
        usage: {
          prompt_tokens: tokens.input,
          completion_tokens: tokens.output,
          total_tokens: tokens.input + tokens.output,
        },
      };
    case 'responses':
      return {
        model,
        status: 'completed',
        output: select
          ? [
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'select_action',
                arguments: args,
                status: 'completed',
              },
            ]
          : [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text }] }],
        usage: {
          input_tokens: tokens.input,
          output_tokens: tokens.output,
          total_tokens: tokens.input + tokens.output,
          input_tokens_details: { cached_tokens: 0 },
        },
      };
    case 'google':
      return {
        modelVersion: model,
        responseId: 'google-response',
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: text ?? args }] } }],
        usageMetadata: {
          promptTokenCount: tokens.input,
          candidatesTokenCount: tokens.output,
          totalTokenCount: tokens.input + tokens.output,
        },
      };
  }
}

/** The same reply as the provider's server-sent events, with text split into `fragments`. */
function events(format, model, { text, select, fragments = [text] }) {
  const args = select && JSON.stringify(select);
  const body = reply(format, model, { text, select });
  switch (format) {
    case 'anthropic':
      return [
        {
          type: 'message_start',
          message: { ...body, content: [], stop_reason: null, usage: { ...body.usage, output_tokens: 1 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: select
            ? { type: 'tool_use', id: 'toolu_1', name: 'select_action', input: {} }
            : { type: 'text', text: '' },
        },
        ...(select
          ? [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } }]
          : fragments.map(fragment => ({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: fragment },
            }))),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: body.stop_reason }, usage: { output_tokens: tokens.output } },
        { type: 'message_stop' },
      ];
    case 'chat':
      return [
        ...(select
          ? [
              {
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'select_action', arguments: args } }],
                    },
                  },
                ],
              },
            ]
          : fragments.map(fragment => ({ model, choices: [{ index: 0, delta: { content: fragment } }] }))),
        { model, choices: [{ index: 0, delta: {}, finish_reason: body.choices[0].finish_reason }] },
        { model, choices: [], usage: body.usage },
        '[DONE]',
      ];
    case 'responses':
      return [
        { type: 'response.created', response: { ...body, status: 'in_progress', output: [], usage: null } },
        ...(select
          ? [{ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1' } }]
          : fragments.map(delta => ({ type: 'response.output_text.delta', delta }))),
        { type: 'response.completed', response: body },
      ];
    case 'google': {
      const chunks = select ? [args] : fragments;
      return chunks.map((fragment, index) => ({
        modelVersion: model,
        candidates: [
          {
            content: { role: 'model', parts: [{ text: fragment }] },
            ...(index === chunks.length - 1 ? { finishReason: 'STOP' } : {}),
          },
        ],
        // Gemini reports cumulative usage; only the last chunk carries the final counts.
        usageMetadata:
          index === chunks.length - 1
            ? body.usageMetadata
            : {
                promptTokenCount: tokens.input,
                candidatesTokenCount: index + 1,
                totalTokenCount: tokens.input + index + 1,
              },
      }));
    }
  }
}

async function providerServer(t, origin) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const path = new URL(req.url, 'http://local').pathname;
    const format = formatOf(path);
    const streamed = body.stream === true || req.url.includes(':streamGenerateContent?alt=sse');
    const kind = isCompletionRequest(body)
      ? 'completion-check'
      : JSON.stringify(body).includes('Write a title for a new chat')
        ? 'title'
        : streamed
          ? 'chat'
          : 'task';
    received.push({ url: req.url, headers: req.headers, body, kind, streamed });
    const model = format === 'google' ? path.match(/models\/([^:]+):/)[1] : body.model;
    const content =
      kind === 'completion-check'
        ? { select: { decision: { status: 'completed', reason: 'The answer is complete.' } } }
        : kind === 'title'
          ? { text: titleText }
          : kind === 'task'
            ? { text: 'Task answer.' }
            : { text: answerFragments.join(''), fragments: answerFragments };
    if (!streamed) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply(format, model, content)));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events(format, model, content)) {
      const data = typeof event === 'string' ? event : JSON.stringify(event);
      res.write(format === 'anthropic' ? `event: ${event.type}\ndata: ${data}\n\n` : `data: ${data}\n\n`);
    }
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.ok(String(url).startsWith(origin), `${url} goes to ${origin}`);
    return originalFetch(`http://127.0.0.1:${server.address().port}/${String(url).slice(origin.length)}`, options);
  });
  return received;
}

/** Pico-USD at the base tier of a catalog model for the fixture usage, computed from the catalog JSON. */
function expectedPicoUsd(modelId) {
  const rate = legacyModels.find(model => model.id === modelId).rates.find(item => item.promptTokensAbove === null);
  return BigInt(
    Math.round((tokens.input * rate.usdPerMillionTokens.input + tokens.output * rate.usdPerMillionTokens.output) * 1e6),
  );
}

function cost(price, usage) {
  assert.equal(usage.kind, 'known');
  const { kind, ...counts } = usage;
  const result = calculateUsageCost({
    modelId: price.modelId,
    pricingRevision: price.pricingRevision,
    rates: price.rates,
    maxInputTokens: price.maxInputTokens,
    maxOutputTokens: price.maxOutputTokens,
    date: new Date().toISOString().slice(0, 10),
    usage: { kind, tokens: counts },
  });
  assert.equal(result.kind, 'known');
  return BigInt(result.providerPicoUsd);
}

for (const [provider, { env, origin }] of Object.entries(providers))
  test(`with only the ${provider} credential, its recommended families chat (streamed), title and run tasks at its own price`, async t => {
    const received = await providerServer(t, origin);
    const enabled = catalogFamilies.filter(family => conversationModel(family, env));
    assert.deepEqual(enabled, recommended[provider]);
    const environment = modelEnvironment(env);
    const continuity = environment.continuity(createMemoryRouteHealth);
    for (const family of enabled) {
      received.length = 0;
      const chat = conversationModel(family, env);
      const title = chatTitleModel(env);
      assert.equal(chat.route.provider, provider, family);
      assert.equal(legacyModels.find(model => model.id === chat.price.modelId).provider, provider, family);

      // Chat with a first-turn title, metered as the worker meters it: by the priced model of the dispatched route.
      const settled = [];
      const published = [];
      const result = await respondToConversation(
        { ...chat.route, maxOutputTokens: chat.price.maxOutputTokens },
        [{ role: 'user', text: 'Review my quarterly plan.' }],
        () => assert.fail('No tool expected'),
        async ({ provider: routeProvider, model }) => {
          const price = [chat, title].find(
            candidate => candidate?.route.provider === routeProvider && candidate.route.model === model,
          )?.price;
          assert.ok(price, `${family} request is priced`);
          return async usage => settled.push({ modelId: price.modelId, picoUsd: cost(price, usage) });
        },
        async () => {},
        true,
        null,
        {
          answerText: ({ text }) => published.push(text),
          titleRoute: title?.route,
          sources: () => [],
        },
      );
      assert.equal(result.text, answerFragments.join(''), family);
      assert.equal(result.title, titleText, family);
      assert.ok(published.length >= 2 && published.at(-1) === answerFragments.join(''), `${family} streams the answer`);
      const chatRequest = received.find(request => request.kind === 'chat');
      assert.ok(chatRequest?.streamed, `${family} chat is streamed`);
      assert.ok(received.find(request => request.kind === 'title')?.streamed, `${family} title is streamed`);
      if (provider === 'google') assert.match(chatRequest.url, /:streamGenerateContent\?alt=sse$/);
      assert.ok(received.every(request => request.kind !== 'task'));
      assert.equal(settled.length, received.length, `${family} meters every request`);
      for (const entry of settled) assert.equal(entry.picoUsd, expectedPicoUsd(entry.modelId), family);
      assert.ok(settled.some(entry => entry.modelId === chat.price.modelId));

      // A task turn through the same environment, priced from the resolution it ran on.
      received.length = 0;
      const resolution = environment.resolve(family);
      assert.equal(resolution.modelId, chat.price.modelId, family);
      assert.equal(continuity.allowed('11111111-1111-4111-8111-111111111111', resolution), true);
      const task = await continuity.infer(
        resolution,
        {
          prompt: 'Summarise the plan.',
          definition: { name: 'Planner', instructions: 'Answer.', tools: [] },
          scope: [],
        },
        10_000,
      );
      assert.equal(task.kind, 'success', `${family} task: ${task.reason}`);
      assert.deepEqual(task.decision, { kind: 'answer', text: 'Task answer.' }, family);
      assert.deepEqual(
        received.map(request => request.kind),
        ['task'],
        family,
      );
      assert.equal(
        cost(
          {
            ...resolution,
            maxInputTokens: resolution.route.maxInputTokens,
            maxOutputTokens: resolution.route.maxOutputTokens,
          },
          task.usage,
        ),
        expectedPicoUsd(chat.price.modelId),
        family,
      );
      const credential = Object.values(env).find(value => value.endsWith('-key'));
      for (const request of [chatRequest, ...received])
        assert.ok(
          [
            request.headers['x-api-key'],
            request.headers['api-key'],
            request.headers['x-goog-api-key'],
            request.headers.authorization,
          ].some(value => value === credential || value === `Bearer ${credential}`),
          `${family} sends the ${provider} credential`,
        );
    }
  });
