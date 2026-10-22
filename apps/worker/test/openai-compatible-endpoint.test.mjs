import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { isCompletionRequest } from './native-chat-fixture.mjs';

// An operator catalog adds a family served by a self-hosted OpenAI-compatible API: a local HTTP server on a random port,
// reached over the real network path with no fetch rewriting. The catalog is read when the config package loads, so the
// server starts and the environment is set before the dynamic imports.
const received = [];
const answerFragments = ['Local ', 'model ', 'answer.'];
const titleText = 'Local plan review';
const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const kind = isCompletionRequest(body)
    ? 'completion-check'
    : JSON.stringify(body).includes('Write a title for a new chat')
      ? 'title'
      : body.stream === true
        ? 'chat'
        : 'task';
  received.push({ method: req.method, path: req.url, headers: req.headers, body, kind });
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  const model = body.model;
  const select = kind === 'completion-check' && {
    id: 'call_1',
    type: 'function',
    function: {
      name: 'select_action',
      arguments: JSON.stringify({ decision: { status: 'completed', reason: 'The answer is complete.' } }),
    },
  };
  const finish = select ? 'tool_calls' : 'stop';
  if (!body.stream) {
    const message = select ? { content: null, tool_calls: [select] } : { content: 'Task answer.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model, choices: [{ index: 0, finish_reason: finish, message }], usage }));
    return;
  }
  const deltas = select
    ? [{ tool_calls: [{ index: 0, ...select }] }]
    : (kind === 'title' ? [titleText] : answerFragments).map(content => ({ content }));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    ...deltas.map(delta => ({ model, choices: [{ index: 0, delta }] })),
    { model, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { model, choices: [], usage },
    '[DONE]',
  ])
    res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const credential = 'local-llm-credential';

process.env.MODEL_CATALOG = JSON.stringify({
  families: [
    {
      id: 'local-llama',
      name: 'Local Llama',
      vendor: 'meta',
      currentModelId: 'local-llama-1',
      modelIds: ['local-llama-1'],
      roles: ['title'],
    },
  ],
  models: [
    {
      id: 'local-llama-1',
      name: 'Local Llama 1',
      provider: 'openai-compatible',
      providerModelId: 'meta-llama/Llama-3.3-70B-Instruct',
      endpoint,
      credentialEnv: 'LOCAL_LLM_API_KEY',
      metadata: { max_input_tokens: 128000, max_output_tokens: 8192 },
      rates: [
        {
          validFrom: null,
          validUntilExclusive: null,
          promptTokensAbove: null,
          usdPerMillionTokens: { input: 0.2, output: 0.6 },
        },
      ],
    },
  ],
});
process.env.MODEL_CATALOG_MODE = 'extend';
delete process.env.MODEL_CATALOG_FILE;
process.env.MODEL_ENDPOINT_HOSTS = '127.0.0.1';
process.env.NODE_ENV = 'test';

const { calculateUsageCost, selectableModelFamilies } = await import('@tulipfarm/config');
const { createMemoryRouteHealth } = await import('@tulipfarm/agents/chat');
const { modelEnvironment } = await import('@tulipfarm/agents/model-environment');
const { conversationModel } = await import('../src/conversation-model.ts');
const { chatTitleModel } = await import('../src/conversation-activities.ts');
const { respondToConversation } = await import('../src/conversation-responder.ts');

// Only the operator's credential is set, so only its family is enabled. Catalog roles apply to listed families.
const credentialOnly = { LOCAL_LLM_API_KEY: credential, MODEL_ENDPOINT_HOSTS: '127.0.0.1', NODE_ENV: 'test' };
const env = { ...credentialOnly, MODEL_FAMILIES: 'local-llama' };
// 1000 input and 500 output tokens at 0.2 and 0.6 USD per million.
const expectedPicoUsd = BigInt(Math.round((1000 * 0.2 + 500 * 0.6) * 1e6));

test.after(() => {
  server.closeAllConnections();
  server.close();
});

function cost(price, result) {
  assert.equal(result.kind, 'known');
  const { kind, ...tokens } = result;
  const priced = calculateUsageCost({
    modelId: price.modelId,
    pricingRevision: price.pricingRevision,
    rates: price.rates,
    maxInputTokens: price.maxInputTokens,
    maxOutputTokens: price.maxOutputTokens,
    date: new Date().toISOString().slice(0, 10),
    usage: { kind, tokens },
  });
  assert.equal(priced.kind, 'known');
  return BigInt(priced.providerPicoUsd);
}

test('an openai-compatible catalog model chats (streamed) and runs a task against its own endpoint', async () => {
  assert.deepEqual(
    selectableModelFamilies.map(family => family.id).filter(family => conversationModel(family, credentialOnly)),
    ['local-llama'],
  );
  const chat = conversationModel('local-llama', env);
  assert.equal(chat.route.provider, 'openai-compatible');
  assert.equal(chat.route.endpoint, `${endpoint}/`);
  assert.equal(chat.route.model, 'meta-llama/Llama-3.3-70B-Instruct');
  const title = chatTitleModel(env);

  received.length = 0;
  const settled = [];
  const published = [];
  const result = await respondToConversation(
    { ...chat.route, maxOutputTokens: chat.price.maxOutputTokens },
    [{ role: 'user', text: 'Review my quarterly plan.' }],
    () => assert.fail('No tool expected'),
    async ({ provider, model }) => {
      const price = [chat, title].find(
        candidate => candidate?.route.provider === provider && candidate.route.model === model,
      )?.price;
      assert.ok(price, 'request is priced');
      return async usage => settled.push(cost(price, usage));
    },
    async () => {},
    true,
    null,
    { answerText: ({ text }) => published.push(text), titleRoute: title?.route, sources: () => [] },
  );
  assert.equal(result.text, answerFragments.join(''));
  assert.ok(published.length >= 2 && published.at(-1) === answerFragments.join(''), 'the answer streams');
  const chatRequest = received.find(request => request.kind === 'chat');
  assert.ok(chatRequest, JSON.stringify(received.map(request => request.kind)));
  assert.equal(chatRequest.body.model, 'meta-llama/Llama-3.3-70B-Instruct');
  assert.equal(chatRequest.body.stream, true);
  assert.equal(title.route.provider, 'openai-compatible');
  assert.equal(result.title, titleText);
  assert.equal(received.find(request => request.kind === 'title')?.body.stream, true);
  assert.equal(settled.length, received.length);
  for (const picoUsd of settled) assert.equal(picoUsd, expectedPicoUsd);

  const chatRequests = received.length;
  const environment = modelEnvironment(env);
  const continuity = environment.continuity(createMemoryRouteHealth);
  const resolution = environment.resolve('local-llama');
  assert.equal(resolution.modelId, 'local-llama-1');
  assert.equal(continuity.allowed('11111111-1111-4111-8111-111111111111', resolution), true);
  const task = await continuity.infer(
    resolution,
    { prompt: 'Summarise the plan.', definition: { name: 'Planner', instructions: 'Answer.', tools: [] }, scope: [] },
    10_000,
  );
  assert.equal(task.kind, 'success', task.reason);
  assert.deepEqual(task.decision, { kind: 'answer', text: 'Task answer.' });
  assert.deepEqual(
    received.slice(chatRequests).map(request => request.kind),
    ['task'],
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
    expectedPicoUsd,
  );

  assert.ok(received.length >= 2);
  for (const request of received) {
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.headers.authorization, ['Bearer', credential].join(' '));
  }
});

test('the credential is never sent when the endpoint host is not allowlisted or http in production', () => {
  received.length = 0;
  for (const unsafe of [
    { ...env, MODEL_ENDPOINT_HOSTS: '' },
    { ...env, MODEL_ENDPOINT_HOSTS: 'localhost' },
    { ...env, NODE_ENV: 'production' },
  ])
    assert.throws(
      () => conversationModel('local-llama', unsafe),
      error =>
        error.message.startsWith('Invalid server model configuration: model "local-llama-1" endpoint ') &&
        !error.message.includes(credential),
    );
  assert.equal(received.length, 0);
});
