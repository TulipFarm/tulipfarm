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
});
