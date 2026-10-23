import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import {
  completionReply,
  conversation,
  formats,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  offeredTools,
  toolResults,
  use,
} from './native-fixture.mjs';

/** Sets the prompt tokens a fixture response reports, with no cached tokens. */
function withUsage(format, body, tokens) {
  if (format === 'anthropic') Object.assign(body.usage, { input_tokens: tokens, cache_read_input_tokens: 0 });
  if (format === 'azure')
    Object.assign(body.usage, {
      prompt_tokens: tokens,
      total_tokens: tokens + body.usage.completion_tokens,
      prompt_tokens_details: { cached_tokens: 0 },
    });
  if (format === 'responses')
    Object.assign(body.usage, {
      input_tokens: tokens,
      total_tokens: tokens + body.usage.output_tokens,
      input_tokens_details: { cached_tokens: 0 },
    });
  if (format === 'google') {
    const { candidatesTokenCount, thoughtsTokenCount } = body.usageMetadata;
    Object.assign(body.usageMetadata, {
      promptTokenCount: tokens,
      cachedContentTokenCount: 0,
      totalTokenCount: tokens + candidatesTokenCount + thoughtsTokenCount,
    });
  }
  return body;
}

const fetchCall = (round, extra = {}) => use('web.fetch', { url: `https://example.com/${round}` }, 'Reading', extra);
const page = round => `page-${round} ${'lorem ipsum dolor '.repeat(660)}`;
const limits = window => ({ window, triggerPercent: 70, targetPercent: 30 });
/** Every tool result output in a request, in order. */
function allOutputs(format, body) {
  const items = conversation(format, body);
  switch (format) {
    case 'anthropic':
      return items.flatMap(item =>
        Array.isArray(item.content)
          ? item.content.filter(block => block.type === 'tool_result').map(b => b.content)
          : [],
      );
    case 'azure':
      return items.filter(item => item.role === 'tool').map(item => item.content);
    case 'responses':
      return items.filter(item => item.type === 'function_call_output').map(item => item.output);
    case 'google':
      return items.flatMap(item =>
        (item.parts ?? []).filter(part => part.functionResponse).map(part => part.functionResponse.response.output),
      );
  }
}
const notesFor = text =>
  JSON.stringify({
    notes: JSON.parse(text).results.map(({ callId, tool }) => ({ callId, note: `${tool} read one page.` })),
  });

for (const format of formats)
  test(`${format} compacts older tool results past the trigger and still answers`, async t => {
    const window = 40000;
    let rounds = 0;
    let compactedRound = 0;
    const summaries = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body)) return Response.json(completionReply(format));
      rounds++;
      assert.ok(Math.ceil(init.body.length / 4) < window, 'no request reaches the window');
      const outputs = allOutputs(format, body);
      if (outputs.some(output => output.includes('summarised to save context'))) {
        compactedRound ||= rounds;
        const latest = toolResults(format, body).at(-1).output;
        assert.match(latest, new RegExp(`page-${rounds - 1} `));
        assert.doesNotMatch(latest, /to save context/);
        assert.ok(outputs.slice(0, -1).every(output => output.includes('summarised to save context')));
        assert.ok(Math.ceil(init.body.length / 4) < (window * 70) / 100);
        assert.ok(offeredTools(format, body).some(tool => tool.name === 'tool_result_read'));
        return Response.json(withUsage(format, nativeReply(format, { text: 'Read every page.' }), 1));
      }
      assert.ok(rounds < 12);
      return Response.json(
        withUsage(
          format,
          nativeReply(format, { calls: [fetchCall(rounds, { id: `fetch_${rounds}` })] }),
          Math.ceil(init.body.length / 4),
        ),
      );
    });
    let executed = 0;
    const result = await inferWithTools(
      nativeRoutes[format],
      [{ role: 'user', text: 'Research this.' }],
      async () => ({ text: page(++executed) }),
      undefined,
      false,
      null,
      {
        context: limits(window),
        compactToolResults: async ({ round, system, text }) => {
          summaries.push(round);
          assert.match(system, /untrusted data/);
          return notesFor(text);
        },
      },
    );
    assert.equal(result.text, 'Read every page.');
    assert.ok(compactedRound > 1);
    assert.deepEqual(summaries, [compactedRound]);
  });

test('a capped result says how much was shown, and tool_result_read returns the rest by call ID', async t => {
  const format = 'anthropic';
  const big = Array.from({ length: 9000 }, (_, index) => `w${index}`).join(' ');
  const full = `Untrusted tool result for web.fetch: ${JSON.stringify({ text: big })}`;
  const capBytes = Math.floor(40000 * 0.1) * 4;
  let read = '';
  let next = 0;
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(completionReply(format));
    rounds++;
    if (rounds === 1) return Response.json(nativeReply(format, { calls: [fetchCall(1, { id: 'fetch_1' })] }));
    const [last] = toolResults(format, body);
    assert.ok(Buffer.byteLength(last.output) <= capBytes);
    if (rounds === 2) {
      assert.match(last.output, new RegExp(`showed characters 0-\\d+ of ${full.length}`));
      assert.ok(offeredTools(format, body).some(tool => tool.name === 'tool_result_read'));
      const shown = Number(/"offset":(\d+)/.exec(last.output)[1]);
      read = last.output.slice(0, shown);
      next = shown;
    } else {
      const chunk = /characters (\d+)-(\d+) of \d+:\n([\s\S]*)\n\[(?:More remains|End of output)/.exec(last.output);
      assert.ok(chunk, last.output.slice(0, 200));
      assert.equal(Number(chunk[1]), next);
      read += chunk[3];
      next = Number(chunk[2]);
      if (last.output.endsWith('[End of output.]'))
        return Response.json(nativeReply(format, { text: 'Read the whole page.' }));
    }
    return Response.json(
      nativeReply(format, {
        calls: [{ name: 'tool_result_read', input: { callId: 'fetch_1', offset: next }, id: `read_${rounds}` }],
      }),
    );
  });
  let executed = 0;
  const result = await inferWithTools(
    nativeRoutes[format],
    [{ role: 'user', text: 'Read this page.' }],
    async () => {
      executed++;
      return { text: big };
    },
    undefined,
    false,
    null,
    { context: limits(40000), priorCalls: 998 },
  );
  assert.equal(result.text, 'Read the whole page.');
  assert.equal(executed, 1, 'rereads run no tool and spend no call budget');
  assert.equal(read, full);
  assert.ok(rounds > 3);
});

test('a failing summariser leaves stubs with the call ID and the reply still answers', async t => {
  const format = 'azure';
  const window = 40000;
  let stubbedRequest;
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(completionReply(format));
    rounds++;
    const outputs = allOutputs(format, body);
    if (outputs.some(output => output.includes('compacted to save context'))) {
      stubbedRequest ??= outputs;
      return Response.json(withUsage(format, nativeReply(format, { text: 'Done from stubs.' }), 1));
    }
    assert.ok(rounds < 12);
    return Response.json(
      withUsage(
        format,
        nativeReply(format, { calls: [fetchCall(rounds, { id: `fetch_${rounds}` })] }),
        Math.ceil(init.body.length / 4),
      ),
    );
  });
  let executed = 0;
  const result = await inferWithTools(
    nativeRoutes[format],
    [],
    async () => ({ text: page(++executed) }),
    undefined,
    false,
    null,
    {
      context: limits(window),
      compactToolResults: async () => {
        throw new Error('compaction-model-unavailable');
      },
    },
  );
  assert.equal(result.text, 'Done from stubs.');
  const [first] = stubbedRequest;
  assert.match(first, /Earlier tool result fetch_1 \(web_fetch\), compacted to save context/);
  assert.match(first, /page-1 lorem/);
  assert.match(first, /tool_result_read \{"callId":"fetch_1","offset":0\}/);
});

test('the estimate is the last round’s reported prompt plus a quarter of the bytes added since', async t => {
  const format = 'anthropic';
  // The fixed prompt alone is over 8400 estimated tokens, so a bytes-only estimate would compact from round 3.
  const reported = [1000, 1000, 8300];
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(completionReply(format));
    rounds++;
    if (rounds > reported.length) return Response.json(nativeReply(format, { text: 'Answered.' }));
    return Response.json(
      withUsage(
        format,
        nativeReply(format, { calls: [fetchCall(rounds, { id: `fetch_${rounds}` })] }),
        reported[rounds - 1],
      ),
    );
  });
  const summaries = [];
  const result = await inferWithTools(
    nativeRoutes[format],
    [],
    async call => ({ text: `${call.url} ${'x'.repeat(2000)}` }),
    undefined,
    false,
    null,
    {
      context: limits(12000),
      compactToolResults: async ({ round, text }) => {
        summaries.push(round);
        return notesFor(text);
      },
    },
  );
  assert.equal(result.text, 'Answered.');
  assert.deepEqual(summaries, [4]);
});

test('compaction unloads searched tools idle for two rounds; tool search can load them again', async t => {
  const format = 'anthropic';
  const offered = [];
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(completionReply(format));
    rounds++;
    offered.push(offeredTools(format, body).map(tool => tool.name));
    if (rounds === 1)
      return Response.json(
        nativeReply(format, { calls: [{ name: 'tools_search', input: { query: 'rows create' }, id: 'search_1' }] }),
      );
    if (rounds <= 5)
      return Response.json(
        withUsage(
          format,
          nativeReply(format, { calls: [fetchCall(rounds, { id: `fetch_${rounds}` })] }),
          1000 * rounds,
        ),
      );
    if (rounds === 6) {
      const search = offeredTools(format, body).find(tool => tool.name === 'tools_search');
      assert.match(search.description, /rows_create/);
    }
    return Response.json(nativeReply(format, { text: 'Answered.' }));
  });
  const result = await inferWithTools(
    nativeRoutes[format],
    [],
    async call => ({ text: `${call.url} ${'x'.repeat(2000)}` }),
    undefined,
    false,
    null,
    // The fifth round reports 5000 prompt tokens, past 70% of a 7000-token window.
    { context: limits(7000), compactToolResults: async ({ text }) => notesFor(text) },
  );
  assert.equal(result.text, 'Answered.');
  assert.ok(!offered[0].includes('rows_create'));
  assert.ok(offered[1].includes('rows_create'));
  assert.ok(offered[4].includes('rows_create'));
  assert.ok(!offered[5].includes('rows_create'));
});

/** Each provider's wording for a request longer than the model's context window. */
const overflowErrors = {
  'OpenAI context_length_exceeded': [
    'azure',
    {
      error: {
        code: 'context_length_exceeded',
        message:
          "This model's maximum context length is 40000 tokens. However, your messages resulted in 52000 tokens.",
      },
    },
  ],
  'xAI maximum prompt length': [
    'azure',
    { error: { message: "This model's maximum prompt length is 40000 but the request contains 52000 tokens." } },
  ],
  'Azure Responses context_length_exceeded': [
    'responses',
    { error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } },
  ],
  'Anthropic prompt is too long': [
    'anthropic',
    {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 52000 tokens > 40000 maximum' },
    },
  ],
  'Google INVALID_ARGUMENT token limit': [
    'google',
    {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'The input token count (52000) exceeds the maximum number of tokens allowed (40000).',
      },
    },
  ],
};

for (const [name, [format, error]] of Object.entries(overflowErrors))
  test(`${name}: a provider overflow compacts every result but the latest round and retries the same step`, async t => {
    const window = 40000;
    let rounds = 0;
    let rejected = 0;
    let retried;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body)) return Response.json(completionReply(format));
      rounds++;
      if (rounds <= 3)
        return Response.json(nativeReply(format, { calls: [fetchCall(rounds, { id: `fetch_${rounds}` })] }));
      const outputs = allOutputs(format, body);
      if (!outputs.some(output => output.includes('to save context'))) {
        rejected++;
        return Response.json(error, { status: 400 });
      }
      retried = outputs;
      return Response.json(nativeReply(format, { text: 'Answered after compaction.' }));
    });
    const settlements = [];
    let executed = 0;
    const result = await inferWithTools(
      nativeRoutes[format],
      [{ role: 'user', text: 'Research this.' }],
      async () => ({ text: page(++executed) }),
      async attempt => async (usage, outcome) =>
        settlements.push({ step: attempt.step, usage: usage.kind, ...outcome }),
      false,
      null,
      { context: limits(window), compactToolResults: async ({ text }) => notesFor(text) },
    );
    assert.equal(result.text, 'Answered after compaction.');
    assert.equal(rejected, 1);
    assert.equal(retried.length, 3);
    assert.ok(retried.slice(0, -1).every(output => output.includes('to save context')));
    assert.match(retried.at(-1), /page-3 /);
    // The rejected call settles as refused, so it is never charged; the retry is a separate, charged step.
    assert.deepEqual(
      settlements.filter(entry => entry.rejected),
      [{ step: settlements.find(entry => entry.rejected).step, usage: 'unknown', rejected: true }],
    );
    // Three tool rounds, the rejected round, its retry, and the completion check.
    assert.equal(settlements.length, 6);
    assert.equal(new Set(settlements.map(entry => entry.step)).size, 6);
  });

test('a second provider overflow stubs the latest round too, and a third ends with conversation-context-overflow', async t => {
  const format = 'azure';
  const [, error] = overflowErrors['OpenAI context_length_exceeded'];
  for (const accept of [2, Infinity]) {
    let rounds = 0;
    const rejectedRequests = [];
    let accepted;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body)) return Response.json(completionReply(format));
      rounds++;
      if (rounds <= 2)
        return Response.json(nativeReply(format, { calls: [fetchCall(rounds, { id: `fetch_${rounds}` })] }));
      const outputs = allOutputs(format, body);
      if (rejectedRequests.length < accept) {
        rejectedRequests.push(outputs);
        return Response.json(error, { status: 400 });
      }
      accepted = outputs;
      return Response.json(nativeReply(format, { text: 'Answered from stubs.' }));
    });
    let executed = 0;
    const reply = inferWithTools(
      nativeRoutes[format],
      [],
      async () => ({ text: page(++executed) }),
      undefined,
      false,
      null,
      { context: limits(40000), compactToolResults: async ({ text }) => notesFor(text) },
    );
    if (accept === Infinity) {
      await assert.rejects(reply, err => {
        assert.equal(err.message, 'conversation-context-overflow');
        assert.equal(err.cause.message, 'model-context-overflow');
        return true;
      });
      assert.equal(rejectedRequests.length, 3);
    } else {
      assert.equal((await reply).text, 'Answered from stubs.');
      assert.equal(rejectedRequests.length, 2);
      assert.ok(
        accepted.every(output => output.includes('compacted to save context')),
        'every result is stubbed',
      );
    }
    t.mock.restoreAll();
  }
});

test('a context-window stop reason is retried after compaction like a rejection', async t => {
  const format = 'anthropic';
  let rounds = 0;
  let stopped = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(completionReply(format));
    rounds++;
    if (rounds <= 2)
      return Response.json(nativeReply(format, { calls: [fetchCall(rounds, { id: `fetch_${rounds}` })] }));
    if (!allOutputs(format, body).some(output => output.includes('to save context'))) {
      stopped++;
      return Response.json({ ...nativeReply(format, { text: '' }), stop_reason: 'model_context_window_exceeded' });
    }
    return Response.json(nativeReply(format, { text: 'Answered.' }));
  });
  let executed = 0;
  const result = await inferWithTools(
    nativeRoutes[format],
    [],
    async () => ({ text: page(++executed) }),
    undefined,
    false,
    null,
    { context: limits(40000) },
  );
  assert.equal(result.text, 'Answered.');
  assert.equal(stopped, 1);
});
