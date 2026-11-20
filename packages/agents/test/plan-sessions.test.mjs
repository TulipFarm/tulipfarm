import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readModelResponse } from '../src/inference-stream.ts';
import { PlanSessionError, planSessionFetch, planSessionsForTest } from '../src/plan-sessions.ts';

const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 };
const tool = { name: 'tables.definitions', description: 'Lists tables', parameters: { type: 'object' } };

/** A vendor that answers each `send` or `resume` with the next scripted step, streaming its words first. */
function scripted(t, steps) {
  const log = [];
  planSessionsForTest.useVendors(async (provider, _token, model, _system, tools) => {
    log.push({ open: provider, model, tools: tools.map(item => item.name) });
    const next = async (kind, value, onText) => {
      log.push({ [kind]: value });
      const step = steps.shift();
      assert.ok(step, 'script exhausted');
      if (step instanceof Error) throw step;
      for (const words of step.words ?? []) onText?.(words);
      if (step.failAfterWords) throw step.failAfterWords;
      return { usage, text: (step.words ?? []).join(''), ...step };
    };
    return {
      send: (prompt, onText) => next('send', prompt, onText),
      resume: (results, onText) => next('resume', results, onText),
      close: () => log.push({ close: true }),
    };
  });
  t.after(() => {
    planSessionsForTest.useVendors();
    planSessionsForTest.sessions.clear();
  });
  return log;
}

async function read(response, format) {
  const shown = [];
  const result = await readModelResponse(response, format, { onText: text => shown.push(text) });
  return { ...result, shown };
}

const claudeBody = (messages, stream = true) =>
  JSON.stringify({
    model: 'claude-haiku-4-5',
    system: 'Be brief.',
    stream,
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
    messages,
  });

const copilotBody = messages =>
  JSON.stringify({
    model: 'gpt-sol',
    stream: true,
    tools: [{ type: 'function', function: tool }],
    messages: [{ role: 'system', content: 'Be brief.' }, ...messages],
  });

test('a streamed Claude plan answer arrives word by word and assembles into one Anthropic message', async t => {
  scripted(t, [{ kind: 'answer', words: ['Once ', 'upon ', 'a time.'] }]);
  const response = await planSessionFetch('claude', 'token', claudeBody([{ role: 'user', content: 'Tell a story' }]));
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const { body, error, shown } = await read(response, 'anthropic');
  assert.equal(error, null);
  assert.deepEqual(shown, ['Once ', 'Once upon ', 'Once upon a time.']);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.content, [{ type: 'text', text: 'Once upon a time.' }]);
  assert.equal(body.usage.input_tokens, usage.input);
  assert.equal(body.usage.output_tokens, usage.output);
});

test('a streamed Copilot tool call resumes the same session with its result instead of sending a new message', async t => {
  const log = scripted(t, [
    { kind: 'calls', words: ['Checking. '], calls: [{ id: 'c1', name: tool.name, input: { limit: 2 } }] },
    { kind: 'answer', words: ['You have ', 'two tables.'] },
  ]);
  const first = [{ role: 'user', content: 'Which tables do I have?' }];
  const calls = await read(await planSessionFetch('copilot', 'token', copilotBody(first)), 'chat-completions');
  const message = calls.body.choices[0].message;
  assert.equal(calls.body.choices[0].finish_reason, 'tool_calls');
  assert.equal(message.content, 'Checking. ');
  assert.deepEqual(
    message.tool_calls.map(call => [call.id, call.function.name, JSON.parse(call.function.arguments)]),
    [['c1', tool.name, { limit: 2 }]],
  );

  const second = [
    ...first,
    { role: 'assistant', content: message.content, tool_calls: message.tool_calls },
    { role: 'tool', tool_call_id: 'c1', content: '["Leads","Orders"]' },
  ];
  const answer = await read(await planSessionFetch('copilot', 'token', copilotBody(second)), 'chat-completions');
  assert.equal(answer.body.choices[0].message.content, 'You have two tables.');
  assert.deepEqual(answer.shown, ['You have ', 'You have two tables.']);
  assert.deepEqual(
    log.map(entry => Object.keys(entry)[0]),
    ['open', 'send', 'resume'],
  );
  assert.deepEqual(log[2].resume, [{ id: 'c1', output: '["Leads","Orders"]', error: false }]);
});

test('a plan failure before any words answers with its HTTP status so the loop can fall back', async t => {
  scripted(t, [new PlanSessionError(429, 'plan_usage_limit', 'Limit reached', 60)]);
  const response = await planSessionFetch('claude', 'token', claudeBody([{ role: 'user', content: 'Hi' }]));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal((await response.json()).error.code, 'plan_usage_limit');
});

for (const [provider, format, body] of [
  ['claude', 'anthropic', claudeBody([{ role: 'user', content: 'Hi' }])],
  ['copilot', 'chat-completions', copilotBody([{ role: 'user', content: 'Hi' }])],
])
  test(`a ${provider} plan failure after words ends the stream with the provider's error event`, async t => {
    scripted(t, [
      { kind: 'answer', words: ['Partial '], failAfterWords: new PlanSessionError(502, 'plan_unavailable', 'Lost') },
    ]);
    const response = await planSessionFetch(provider, 'token', body);
    assert.equal(response.status, 200);
    const { error, shown } = await read(response, format);
    assert.deepEqual(shown, ['Partial ']);
    assert.equal(error.error.message, 'Lost');
  });

test('a non-streamed request still answers with one JSON message', async t => {
  scripted(t, [{ kind: 'answer', words: ['Hi there.'] }]);
  const response = await planSessionFetch('claude', 'token', claudeBody([{ role: 'user', content: 'Hi' }], false));
  const body = await response.json();
  assert.deepEqual(body.content, [{ type: 'text', text: 'Hi there.' }]);
});

test('Copilot tool aliases use only allowed characters, stay unique and map back to the real names', () => {
  const names = ['tables.definitions', 'web_fetch', 'a.b', 'a_b', 'a-b'];
  const { aliases, original } = planSessionsForTest.toolAliases(names);
  for (const alias of aliases) assert.match(alias, /^[A-Za-z0-9_-]+$/);
  assert.equal(new Set(aliases).size, names.length);
  assert.deepEqual(
    aliases.map(alias => original.get(alias)),
    names,
  );
  assert.equal(aliases[1], 'web_fetch');
  assert.equal(aliases[3], 'a_b', 'A name that is already safe keeps it');
});

test('tool results followed by an image turn open a new session instead of failing the round', async t => {
  const log = scripted(t, [
    { kind: 'calls', calls: [{ id: 'c1', name: tool.name, input: {} }] },
    { kind: 'answer', words: ['It shows a chart.'] },
  ]);
  const first = [{ role: 'user', content: 'Describe the chart' }];
  const calls = await read(await planSessionFetch('copilot', 'token', copilotBody(first)), 'chat-completions');
  const message = calls.body.choices[0].message;
  const second = [
    ...first,
    { role: 'assistant', content: message.content, tool_calls: message.tool_calls },
    { role: 'tool', tool_call_id: 'c1', content: '{"file":"chart.png"}' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
  ];
  const answer = await read(await planSessionFetch('copilot', 'token', copilotBody(second)), 'chat-completions');
  assert.equal(answer.error, null);
  assert.equal(answer.body.choices[0].message.content, 'It shows a chart.');
  assert.deepEqual(
    log.map(entry => Object.keys(entry)[0]),
    ['open', 'send', 'open', 'send'],
  );
});

test('a context overflow never reads as a sign-out, so the member keeps their token', () => {
  const { claudeError, copilotError } = planSessionsForTest;
  for (const message of [
    'prompt is too long: 215000 tokens > 200000 maximum',
    'input length and max_tokens exceed context limit',
    'Request too large: exceeds the maximum token count',
  ]) {
    assert.equal(claudeError(message).code, 'context_length_exceeded', message);
    assert.equal(copilotError({ message }).code, 'context_length_exceeded', message);
  }
  assert.equal(
    copilotError({ errorType: 'context_limit', message: 'too many tokens' }).code,
    'context_length_exceeded',
  );
  assert.equal(claudeError('OAuth token has expired').code, 'plan_reconnect');
  assert.equal(claudeError('Invalid API key · Please run /login').code, 'plan_reconnect');
  assert.equal(copilotError({ message: 'Bad credentials' }).code, 'plan_reconnect');
  assert.equal(copilotError({ statusCode: 401, message: 'Unauthorized' }).code, 'plan_reconnect');
  assert.equal(claudeError('Claude AI usage limit reached|1760000000').code, 'plan_usage_limit');
  const githubQuota = copilotError({
    message:
      'Request session.create failed with message: Standalone managed telemetry preparation failed: Failed to fetch ' +
      'Copilot user info: 403 Forbidden: {"message":"API rate limit exceeded for user ID 1."}',
  });
  assert.equal(githubQuota.code, 'plan_usage_limit');
  assert.equal(githubQuota.retryAfterSeconds, 60);
});

/**
 * Stands in for the Claude Agent SDK's `query` behind the real Claude vendor. Each user message runs the next script,
 * which emits SDK messages and calls the session's MCP tools the way Claude Code does.
 */
function fakeClaude(t, scripts) {
  planSessionsForTest.useClaudeQuery(({ prompt, options }) => {
    const queue = [];
    let wake;
    let done = false;
    const emit = message => {
      queue.push(message);
      wake?.();
    };
    const client = (async () => {
      const [{ Client }, { InMemoryTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/inMemory.js'),
      ]);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await options.mcpServers.tulipfarm.instance.connect(serverSide);
      const connected = new Client({ name: 'claude-code', version: '1.0.0' });
      await connected.connect(clientSide);
      return connected;
    })();
    const claude = {
      stream: type => emit({ type: 'stream_event', parent_tool_use_id: null, event: { type } }),
      /** Emits one tool_use block of message `msg_1` and starts running it at once, as the streaming executor does. */
      use(id, table) {
        emit({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: 'msg_1',
            content: [{ type: 'tool_use', id, name: `mcp__tulipfarm__${tool.name}`, input: { table } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        });
        return client.then(connected => connected.callTool({ name: tool.name, arguments: { table } }));
      },
      answer(words) {
        emit({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { id: 'msg_2', content: [{ type: 'text', text: words }] },
        });
        emit({ type: 'result', subtype: 'success', result: words });
      },
    };
    void (async () => {
      for await (const _ of prompt) await scripts.shift()(claude);
      done = true;
      wake?.();
    })();
    options.abortController.signal.addEventListener('abort', () => {
      done = true;
      wake?.();
    });
    return (async function* () {
      while (true) {
        while (queue.length) yield queue.shift();
        if (done) return;
        await new Promise(resolve => (wake = resolve));
      }
    })();
  });
  t.after(() => {
    planSessionsForTest.useClaudeQuery();
    for (const pool of planSessionsForTest.sessions.values()) for (const session of pool) session.close();
    planSessionsForTest.sessions.clear();
  });
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** One non-streamed Claude plan request; a lost tool call fails it within seconds instead of hanging the suite. */
async function claudeStep(messages) {
  const response = await planSessionFetch('claude', 'token', claudeBody(messages, false), AbortSignal.timeout(3000));
  return response.json();
}
const toolUses = body => body.content.filter(block => block.type === 'tool_use');
const resultsFor = uses => ({
  role: 'user',
  content: uses.map(use => ({ type: 'tool_result', tool_use_id: use.id, content: `rows of ${use.input.table}` })),
});

test('a Claude plan step waits for the whole message when Claude Code starts one tool before the next streams', async t => {
  const seen = [];
  fakeClaude(t, [
    async claude => {
      claude.stream('message_start');
      const first = claude.use('toolu_a', 'deals');
      // The second tool_use is still streaming while the first call waits for the loop.
      await pause(300);
      const second = claude.use('toolu_b', 'people');
      claude.stream('message_delta');
      claude.stream('message_stop');
      for (const result of await Promise.all([first, second])) seen.push(result.content[0].text);
      claude.answer('Two tables.');
    },
  ]);
  const ask = [{ role: 'user', content: 'Which tables?' }];
  const calls = await claudeStep(ask);
  assert.equal(calls.stop_reason, 'tool_use');
  const uses = toolUses(calls);
  assert.deepEqual(
    uses.map(use => use.id),
    ['toolu_a', 'toolu_b'],
  );
  const answer = await claudeStep([...ask, { role: 'assistant', content: calls.content }, resultsFor(uses)]);
  assert.equal(answer.stop_reason, 'end_turn');
  assert.deepEqual(seen, ['rows of deals', 'rows of people']);
});

test('a Claude plan tool call that arrives after its step settled is the next step instead of a hang', async t => {
  fakeClaude(t, [
    async claude => {
      // No stream events, so the first waiting call settles the step on its own.
      const first = claude.use('toolu_a', 'deals');
      await pause(200);
      const second = claude.use('toolu_b', 'people');
      await Promise.all([first, second]);
      claude.answer('Two tables.');
    },
  ]);
  const ask = [{ role: 'user', content: 'Which tables?' }];
  const firstStep = await claudeStep(ask);
  assert.deepEqual(
    toolUses(firstStep).map(use => use.id),
    ['toolu_a'],
  );
  // The loop runs the first tool while the second tool_use arrives.
  await pause(400);
  const asked = [...ask, { role: 'assistant', content: firstStep.content }, resultsFor(toolUses(firstStep))];
  const secondStep = await claudeStep(asked);
  assert.deepEqual(
    toolUses(secondStep).map(use => use.id),
    ['toolu_b'],
  );
  const answer = await claudeStep([
    ...asked,
    { role: 'assistant', content: secondStep.content },
    resultsFor(toolUses(secondStep)),
  ]);
  assert.equal(answer.stop_reason, 'end_turn');
  assert.deepEqual(answer.content, [{ type: 'text', text: 'Two tables.' }]);
});

test('idle plan sessions close so a worker keeps only a few Claude Code processes open', async t => {
  const asks = 5;
  const log = scripted(
    t,
    Array.from({ length: asks }, (_, index) => ({ kind: 'answer', words: [`Reply ${index}`] })),
  );
  for (let index = 0; index < asks; index++) {
    const response = await planSessionFetch('claude', 'token', claudeBody([{ role: 'user', content: `Ask ${index}` }]));
    assert.equal((await read(response, 'anthropic')).error, null);
  }
  const open = [...planSessionsForTest.sessions.values()].reduce((sum, set) => sum + set.size, 0);
  assert.equal(open, planSessionsForTest.maxSessions);
  assert.equal(log.filter(entry => entry.close).length, asks - planSessionsForTest.maxSessions);
});

test('a session waiting for tool results outlives answered ones when room is needed', async t => {
  const log = scripted(t, [
    { kind: 'calls', calls: [{ id: 'c1', name: tool.name, input: {} }] },
    { kind: 'answer', words: ['One'] },
    { kind: 'answer', words: ['Two'] },
    { kind: 'answer', words: ['Done'] },
  ]);
  const first = [{ role: 'user', content: 'List tables' }];
  const calls = await read(await planSessionFetch('claude', 'token', claudeBody(first)), 'anthropic');
  for (const ask of ['Other one', 'Other two'])
    await read(await planSessionFetch('claude', 'token', claudeBody([{ role: 'user', content: ask }])), 'anthropic');
  const resumed = [
    ...first,
    { role: 'assistant', content: calls.body.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '[]' }] },
  ];
  const answer = await read(await planSessionFetch('claude', 'token', claudeBody(resumed)), 'anthropic');
  assert.equal(answer.error, null);
  assert.ok(
    log.some(entry => entry.resume),
    'the paused session resumed instead of reopening',
  );
});
