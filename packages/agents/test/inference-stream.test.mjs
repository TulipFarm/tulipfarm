import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { inferWithTools } from '../dist/inference.js';
import { serverSentEvents } from '../dist/inference-stream.js';
import { selectReply } from './native-fixture.mjs';

const encoder = new TextEncoder();
const known = { kind: 'known', input: 10, output: 7, cacheRead: 3, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
const routes = {
  forced: {
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com/',
    model: 'claude-forced-5',
    apiKey: 'synthetic-key',
  },
  auto: {
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com/',
    model: 'claude-opus-5-5',
    apiKey: 'synthetic-key',
  },
  azure: {
    provider: 'azure',
    endpoint: 'https://synthetic.openai.azure.com/',
    model: 'synthetic-deployment',
    auth: { kind: 'api-key', value: 'synthetic-key' },
  },
  astra: {
    provider: 'azure',
    endpoint: 'https://synthetic.openai.azure.com/',
    model: 'gpt-6-astra',
    auth: { kind: 'api-key', value: 'synthetic-key' },
  },
};
const fetchArguments = JSON.stringify({ activity: 'Reading the page', url: 'https://example.com/a' });

function sse(events, eol = '\n') {
  return events
    .map(event =>
      typeof event === 'string'
        ? `${event}${eol}${eol}`
        : `event: ${event.type}${eol}data: ${JSON.stringify(event)}${eol}${eol}`,
    )
    .join('');
}
function cut(bytes, offsets) {
  const points = [...new Set([0, ...offsets.filter(offset => offset > 0 && offset < bytes.length), bytes.length])].sort(
    (left, right) => left - right,
  );
  return points.slice(1).map((end, index) => bytes.slice(points[index], end));
}
function every(size, length) {
  return Array.from({ length: Math.ceil(length / size) }, (_, index) => index * size);
}
function streamed(parts, contentType = 'text/event-stream') {
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index < parts.length) controller.enqueue(parts[index++]);
        else controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': contentType } },
  );
}
function provider(t, replies) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    const checked = completionReply(url, body);
    if (checked) return Response.json(checked);
    requests.push({ url: String(url), body });
    return replies[requests.length - 1]();
  });
  return requests;
}
function completionReply(url, body) {
  if (
    !JSON.stringify(body.system ?? body.messages?.[0] ?? body.input?.[0]).includes(
      'Check whether a proposed chat reply',
    )
  )
    return null;
  const format = String(url).includes('/responses')
    ? 'responses'
    : String(url).includes('/messages')
      ? 'anthropic'
      : 'azure';
  return selectReply(format, {
    status: 'completed',
    reason: 'The synthetic reply is sufficient for this stream assembly fixture.',
  });
}
function anthropic(blocks, stopReason) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'actual-anthropic',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
      },
    },
    { type: 'ping' },
    ...blocks.flatMap((block, index) => [
      {
        type: 'content_block_start',
        index,
        content_block:
          block.type === 'text'
            ? { type: 'text', text: '' }
            : { type: 'tool_use', id: `toolu_${index}`, name: block.name ?? 'web_fetch', input: {} },
      },
      ...block.fragments.map(fragment => ({
        type: 'content_block_delta',
        index,
        delta:
          block.type === 'text'
            ? { type: 'text_delta', text: fragment }
            : { type: 'input_json_delta', partial_json: fragment },
      })),
      { type: 'content_block_stop', index },
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: null, output_tokens: 7 },
    },
    { type: 'message_stop' },
  ];
}
function recorder() {
  const updates = [];
  return { updates, answerText: update => updates.push(update) };
}

test('split text tool envelopes never reach the streamed reply and recover as normal text', async t => {
  const text = JSON.stringify({
    kind: 'tool',
    call: {
      tool: 'rows.create',
      tableId: '11111111-1111-4111-8111-111111111111',
      expectedAppliedRevision: 'a'.repeat(40),
      values: {},
    },
  });
  for (const value of [text, `\`\`\`json\n${text}\n\`\`\``]) {
    t.mock.restoreAll();
    provider(t, [
      () => streamed([encoder.encode(sse(anthropic([{ type: 'text', fragments: [...value] }], 'end_turn')))]),
      () =>
        streamed([
          encoder.encode(sse(anthropic([{ type: 'text', fragments: ['No rows were created.'] }], 'end_turn'))),
        ]),
    ]);
    const { updates, answerText } = recorder();
    const result = await inferWithTools(
      routes.auto,
      [{ role: 'user', text: 'Create tickets.' }],
      () => assert.fail('No text tool should run'),
      undefined,
      false,
      null,
      { answerText },
    );
    assert.equal(result.text, 'No rows were created.');
    assert.deepEqual(
      updates.filter(update => update.text),
      [{ step: 1, text: 'No rows were created.' }],
    );
  }
});

test('ordinary JSON and Markdown answers are published after classification without losing content', async t => {
  for (const text of [
    '{"tickets":5}',
    'Read [the guide](https://example.com/).',
    'Example:\n```json\n{"tickets":5}\n```',
  ]) {
    t.mock.restoreAll();
    provider(t, [
      () => streamed([encoder.encode(sse(anthropic([{ type: 'text', fragments: [...text] }], 'end_turn')))]),
    ]);
    const { updates, answerText } = recorder();
    assert.deepEqual(
      await inferWithTools(
        routes.auto,
        [{ role: 'user', text: 'Show the result.' }],
        () => assert.fail(),
        undefined,
        false,
        null,
        { answerText },
      ),
      { text },
    );
    assert.equal(updates.at(-1).text, text);
  }
});

test('SSE parsing survives CRLF, CR, comments, multi-line data and splits inside lines and UTF-8 characters', async () => {
  const bytes = encoder.encode(
    ': keepalive\r\nevent: a\r\ndata: one\r\ndata:two\r\n\r\ndata: é😀\n\nevent: dropped\n\ndata: cr\r\rdata: tail',
  );
  const events = [];
  for await (const event of serverSentEvents(streamed(cut(bytes, every(1, bytes.length))).body)) events.push(event);
  assert.deepEqual(events, [
    { event: 'a', data: 'one\ntwo' },
    { event: 'message', data: 'é😀' },
    { event: 'message', data: 'cr' },
    { event: 'message', data: 'tail' },
  ]);
});

test('Anthropic streams nothing for a tool step and the growing plain answer for the next step', async t => {
  const answerStream = sse(anthropic([{ type: 'text', fragments: ['Caf', 'é 😀', ' ok'] }], 'end_turn'), '\r\n');
  const bytes = encoder.encode(answerStream);
  const emoji = encoder.encode(answerStream.slice(0, answerStream.indexOf('😀'))).length;
  const requests = provider(t, [
    () =>
      streamed(
        cut(
          encoder.encode(
            sse(
              anthropic(
                [{ type: 'tool_use', fragments: [fetchArguments.slice(0, 30), fetchArguments.slice(30)] }],
                'tool_use',
              ),
            ),
          ),
          every(9, 4000),
        ),
      ),
    () => streamed(cut(bytes, [...every(5, bytes.length), emoji + 2])),
  ]);
  const { updates, answerText } = recorder();
  const metered = [];
  const executed = [];
  const result = await inferWithTools(
    routes.forced,
    [{ role: 'user', text: 'Read the page' }],
    async (call, activity) => {
      executed.push({ call, activity });
      return { text: 'page' };
    },
    async ({ step }) =>
      async usage =>
        metered.push({ step, usage }),
    false,
    null,
    { answerText },
  );
  assert.deepEqual(result, { text: 'Café 😀 ok' });
  assert.deepEqual(updates, [
    { step: 1, text: 'Caf' },
    { step: 1, text: 'Café 😀' },
    { step: 1, text: 'Café 😀 ok' },
  ]);
  assert.deepEqual(executed, [
    { call: { tool: 'web.fetch', url: 'https://example.com/a' }, activity: 'Reading the page' },
  ]);
  assert.deepEqual(metered, [
    { step: 0, usage: known },
    { step: 1, usage: known },
    { step: 2, usage: known },
  ]);
  assert.deepEqual(
    requests.map(request => request.body.stream),
    [true, true],
  );
  assert.deepEqual(requests[1].body.messages.at(-2).content, [
    { type: 'tool_use', id: 'toolu_0', name: 'web_fetch', input: JSON.parse(fetchArguments) },
  ]);
  assert.deepEqual(
    requests[1].body.messages.at(-1).content.map(block => block.tool_use_id),
    ['toolu_0'],
  );
});

test('Anthropic streams plain text and blanks it once a tool call starts', async t => {
  provider(t, [
    () => streamed([encoder.encode(sse(anthropic([{ type: 'text', fragments: ['Hello', ' there'] }], 'end_turn')))]),
    () =>
      streamed(
        cut(
          encoder.encode(
            sse(
              anthropic(
                [
                  { type: 'text', fragments: ['Let me check'] },
                  { type: 'tool_use', fragments: ['', fetchArguments] },
                ],
                'tool_use',
              ),
            ),
          ),
          every(40, 4000),
        ),
      ),
    () => streamed([encoder.encode(sse(anthropic([{ type: 'text', fragments: ['Fin', 'al'] }], 'end_turn')))]),
  ]);
  const plain = recorder();
  assert.deepEqual(
    await inferWithTools(
      routes.auto,
      [{ role: 'user', text: 'Hi' }],
      () => assert.fail('No tool expected'),
      undefined,
      false,
      null,
      { answerText: plain.answerText },
    ),
    { text: 'Hello there' },
  );
  assert.deepEqual(plain.updates, [
    { step: 0, text: 'Hello' },
    { step: 0, text: 'Hello there' },
  ]);
  const replaced = recorder();
  assert.deepEqual(
    await inferWithTools(
      routes.auto,
      [{ role: 'user', text: 'Hi' }],
      async () => ({ text: 'page' }),
      undefined,
      false,
      null,
      { answerText: replaced.answerText },
    ),
    { text: 'Final' },
  );
  assert.deepEqual(replaced.updates, [
    { step: 0, text: 'Let me check' },
    { step: 0, text: '' },
    { step: 1, text: 'Fin' },
    { step: 1, text: 'Final' },
  ]);
});

test('a throwing answer consumer does not affect the turn', async t => {
  provider(t, [
    () => streamed([encoder.encode(sse(anthropic([{ type: 'text', fragments: ['Still', ' fine'] }], 'end_turn')))]),
  ]);
  const result = await inferWithTools(
    routes.auto,
    [{ role: 'user', text: 'Hi' }],
    () => assert.fail('No tool expected'),
    undefined,
    false,
    null,
    {
      answerText: () => {
        throw new Error('consumer failed');
      },
    },
  );
  assert.deepEqual(result, { text: 'Still fine' });
});

test('Azure chat completions assemble tool call deltas, blank streamed text, and never stream the separate title', async t => {
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'actual-azure' };
  const usage = {
    prompt_tokens: 13,
    completion_tokens: 7,
    total_tokens: 20,
    prompt_tokens_details: { cached_tokens: 3 },
  };
  const lines = chunks =>
    [...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].map(line =>
      encoder.encode(line),
    );
  const content = fragments =>
    fragments.map(fragment => ({
      ...base,
      choices: [{ index: 0, delta: { content: fragment }, finish_reason: null }],
    }));
  const finish = reason => [
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }] },
    { ...base, choices: [], usage },
  ];
  const requests = provider(t, [
    () =>
      streamed(
        lines([
          { id: '', object: '', model: '', choices: [], prompt_filter_results: [] },
          ...content(['Checking']),
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'web_fetch', arguments: '' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          ...[fetchArguments.slice(0, 20), fetchArguments.slice(20)].map(fragment => ({
            ...base,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
                finish_reason: null,
              },
            ],
          })),
          ...finish('tool_calls'),
        ]),
      ),
    () => streamed(lines([...content(['Rea', 'dy now']), ...finish('stop')])),
    () => streamed(lines([...content(['Secret ', 'title']), ...finish('stop')])),
  ]);
  const { updates, answerText } = recorder();
  const metered = [];
  const result = await inferWithTools(
    routes.azure,
    [{ role: 'user', text: 'Hi' }],
    async () => ({ text: 'page' }),
    async () => async usage => metered.push(usage),
    true,
    null,
    { answerText },
  );
  assert.deepEqual(result, { text: 'Ready now', title: 'Secret title' });
  assert.deepEqual(updates, [
    { step: 0, text: 'Checking' },
    { step: 0, text: '' },
    { step: 1, text: 'Rea' },
    { step: 1, text: 'Ready now' },
  ]);
  assert.deepEqual(metered, [known, known, known, known]);
  for (const request of requests) {
    assert.equal(request.body.stream, true);
    assert.deepEqual(request.body.stream_options, { include_usage: true });
  }
  assert.deepEqual(requests[1].body.messages.at(-2), {
    role: 'assistant',
    content: 'Checking',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_fetch', arguments: fetchArguments } }],
  });
  assert.deepEqual(requests[1].body.messages.at(-1), {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'Untrusted tool result for web.fetch: {"text":"page"}',
  });
  assert.equal(requests[2].body.tools, undefined);
});

test('the Responses API streams output text deltas and uses the completed response', async t => {
  const completed = {
    id: 'resp_1',
    model: 'gpt-6-astra',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1' },
      { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Astra says hi' }] },
    ],
    usage: { input_tokens: 13, output_tokens: 7, total_tokens: 20, input_tokens_details: { cached_tokens: 3 } },
  };
  const events = [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'Astra ' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'says hi' },
    { type: 'response.output_text.done', item_id: 'msg_1', output_index: 1, text: 'Astra says hi' },
    { type: 'response.completed', response: completed },
  ];
  const requests = provider(t, [() => streamed(events.map(event => encoder.encode(sse([event]))))]);
  const { updates, answerText } = recorder();
  const metered = [];
  const result = await inferWithTools(
    routes.astra,
    [{ role: 'user', text: 'Hi' }],
    () => assert.fail('No tool expected'),
    async () => async usage => metered.push(usage),
    false,
    null,
    { answerText },
  );
  assert.deepEqual(result, { text: 'Astra says hi' });
  assert.deepEqual(updates, [
    { step: 0, text: 'Astra ' },
    { step: 0, text: 'Astra says hi' },
  ]);
  assert.deepEqual(metered, [known, known]);
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.stream_options, undefined);
});

test('the Responses API blanks streamed text once a function call starts and runs the call', async t => {
  const call = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    status: 'completed',
    name: 'web_fetch',
    arguments: fetchArguments,
  };
  const usage = { input_tokens: 13, output_tokens: 7, total_tokens: 20, input_tokens_details: { cached_tokens: 3 } };
  const requests = provider(t, [
    () =>
      streamed(
        [
          { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'Let me read it.' },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: { ...call, arguments: '', status: 'in_progress' },
          },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: fetchArguments },
          {
            type: 'response.completed',
            response: {
              model: 'gpt-6-astra',
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'Let me read it.' }] }, call],
              usage,
            },
          },
        ].map(event => encoder.encode(sse([event]))),
      ),
    () =>
      streamed(
        [
          { type: 'response.output_text.delta', delta: 'Done' },
          {
            type: 'response.completed',
            response: {
              model: 'gpt-6-astra',
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }],
              usage,
            },
          },
        ].map(event => encoder.encode(sse([event]))),
      ),
  ]);
  const { updates, answerText } = recorder();
  const executed = [];
  assert.deepEqual(
    await inferWithTools(
      routes.astra,
      [{ role: 'user', text: 'Read a' }],
      async value => {
        executed.push(value);
        return { text: 'page' };
      },
      undefined,
      false,
      null,
      { answerText },
    ),
    { text: 'Done' },
  );
  assert.deepEqual(updates, [
    { step: 0, text: 'Let me read it.' },
    { step: 0, text: '' },
    { step: 1, text: 'Done' },
  ]);
  assert.deepEqual(executed, [{ tool: 'web.fetch', url: 'https://example.com/a' }]);
  assert.deepEqual(requests[1].body.input.slice(-3), [
    { role: 'assistant', content: 'Let me read it.' },
    { type: 'function_call', call_id: 'call_1', name: 'web_fetch', arguments: fetchArguments },
    { type: 'function_call_output', call_id: 'call_1', output: 'Untrusted tool result for web.fetch: {"text":"page"}' },
  ]);
});

test('a JSON reply to a streaming request still parses and reports no streamed text', async t => {
  const body = {
    model: 'actual-anthropic',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'From JSON.' }],
    usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
  };
  provider(t, [() => streamed([encoder.encode(JSON.stringify(body))], 'application/json')]);
  const { updates, answerText } = recorder();
  const metered = [];
  assert.deepEqual(
    await inferWithTools(
      routes.forced,
      [{ role: 'user', text: 'Hi' }],
      () => assert.fail('No tool expected'),
      async () => async usage => metered.push(usage),
      false,
      null,
      { answerText },
    ),
    { text: 'From JSON.' },
  );
  assert.deepEqual({ updates, metered }, { updates: [], metered: [known, known] });
});

test('malformed streams take the empty-or-malformed correction path', async t => {
  const requests = provider(t, [
    () =>
      streamed([
        encoder.encode(
          sse(
            anthropic(
              [
                { type: 'text', fragments: ['Brok'] },
                { type: 'tool_use', fragments: ['{"url":"htt'] },
              ],
              'tool_use',
            ),
          ),
        ),
      ]),
    () => streamed([encoder.encode(`${sse(anthropic([], 'end_turn').slice(0, 1))}data: {oops\n\n`)]),
    () => streamed([encoder.encode(sse(anthropic([{ type: 'text', fragments: ['Fixed'] }], 'end_turn')))]),
  ]);
  const { updates, answerText } = recorder();
  assert.deepEqual(
    await inferWithTools(
      routes.forced,
      [{ role: 'user', text: 'Hi' }],
      () => assert.fail('No tool expected'),
      undefined,
      false,
      null,
      { answerText },
    ),
    { text: 'Fixed' },
  );
  assert.deepEqual(updates, [
    { step: 0, text: 'Brok' },
    { step: 0, text: '' },
    { step: 2, text: 'Fixed' },
  ]);
  assert.match(
    requests[1].body.messages.at(-1).content,
    /^Your last response was empty or malformed, so it was ignored\./,
  );
  assert.match(
    requests[2].body.messages.at(-1).content,
    /^Your last response was empty or malformed, so it was ignored\./,
  );
});

test('an in-stream provider error fails like the matching HTTP error with unknown usage', async t => {
  provider(t, [
    () =>
      streamed([
        encoder.encode(
          sse([
            anthropic([], 'end_turn')[0],
            { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
          ]),
        ),
      ]),
  ]);
  const metered = [];
  await assert.rejects(
    inferWithTools(
      routes.forced,
      [{ role: 'user', text: 'Hi' }],
      () => assert.fail('No tool expected'),
      async () => async usage => metered.push(usage),
    ),
    { message: 'model-overload' },
  );
  assert.deepEqual(metered, [{ kind: 'unknown' }]);
});

test('a real HTTP event stream reports chat-completions text as it arrives', async t => {
  const server = createServer(async (req, res) => {
    req.resume();
    await once(req, 'end');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const base = { id: 'chatcmpl-1', model: 'actual-azure' };
    for (const chunk of [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hold' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { content: ' on' }, finish_reason: 'stop' }] },
      {
        ...base,
        choices: [],
        usage: {
          prompt_tokens: 13,
          completion_tokens: 7,
          total_tokens: 20,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
    ]) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const checked = completionReply(url, JSON.parse(options.body));
    return checked
      ? Promise.resolve(Response.json(checked))
      : originalFetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, options);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { updates, answerText } = recorder();
  const metered = [];
  assert.deepEqual(
    await inferWithTools(
      routes.azure,
      [{ role: 'user', text: 'Hi' }],
      () => assert.fail('No tool expected'),
      async () => async usage => metered.push(usage),
      false,
      null,
      { answerText },
    ),
    { text: 'Hold on' },
  );
  assert.deepEqual(
    { updates, metered },
    {
      updates: [
        { step: 0, text: 'Hold' },
        { step: 0, text: 'Hold on' },
      ],
      metered: [known, known],
    },
  );
});
