import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { titleSystemPrompt } from '../src/prompts.ts';
import { chatToolCallLimit } from '../../conversations/src/contracts.ts';
import {
  completionReply,
  isCompletionRequest,
  conversation,
  formats,
  nativeReply,
  nativeRoutes,
  offeredTools,
  use,
} from './native-fixture.mjs';

for (const format of formats)
  test(`${format} asks for a title in a separate plain-text call only when requested`, async t => {
    const route = nativeRoutes[format];
    const requests = [];
    const replies = [
      nativeReply(format, { calls: [use('tables.definitions', {}, 'Listing your tables')] }),
      nativeReply(format, { text: 'Here are your resources.' }),
      completionReply(format),
      nativeReply(format, { text: 'Resource overview' }),
    ];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json(replies.shift());
    });
    const metered = [];
    let tools = 0;
    const messages = [
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi.' },
      { role: 'user', text: 'List our resources' },
    ];
    assert.deepEqual(
      await inferWithTools(
        route,
        messages,
        async () => {
          tools++;
          return { tables: [] };
        },
        async ({ step }) =>
          async () =>
            metered.push(step),
        true,
      ),
      { text: 'Here are your resources.', title: 'Resource overview' },
    );
    assert.equal(tools, 1);
    assert.deepEqual(metered, [0, 1, 2, 3]);
    assert.equal(requests.length, 4);
    assert.ok(isCompletionRequest(requests[2]));
    for (const request of requests.slice(0, 2)) {
      assert.ok(offeredTools(format, request).some(tool => tool.name === 'tables_definitions'));
      assert.doesNotMatch(JSON.stringify(request), /generateTitle|Write a title for a new chat/);
    }
    const titleRequest = requests[3];
    assert.equal(titleRequest.tools, undefined);
    assert.ok(JSON.stringify(titleRequest).includes(JSON.stringify(titleSystemPrompt).slice(1, -1)));
    const context = JSON.stringify(conversation(format, titleRequest));
    assert.match(context, /List our resources/);
    assert.doesNotMatch(context, /Hello|Hi\.|Here are your resources/);

    requests.length = 0;
    replies.push(nativeReply(format, { text: 'Here are your resources.' }), completionReply(format));
    assert.deepEqual(await inferWithTools(route, messages, () => assert.fail('No tool expected')), {
      text: 'Here are your resources.',
    });
    assert.equal(requests.length, 2);
  });

for (const format of formats)
  for (const ending of ['tool-call', 'tool-envelope', 'incomplete'])
    test(`${format} still titles a first turn after the tool budget stops ${ending}`, async t => {
      const requests = [];
      const sourceMessages = [{ role: 'user', text: 'Review our launch plan' }];
      const messages = [...sourceMessages, { role: 'user', text: 'PRIVATE_FILE_CONTEXT' }];
      const replies = [
        nativeReply(
          format,
          ending === 'tool-call'
            ? { calls: [use('tables.definitions')] }
            : {
                text:
                  ending === 'tool-envelope'
                    ? '{"kind":"tool","call":{"tool":"tables.definitions"}}'
                    : 'I will keep working.',
              },
        ),
        ...(ending === 'incomplete' ? [completionReply(format, 'continue')] : []),
        nativeReply(format, { text: 'Launch plan review' }),
      ];
      t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(options.body));
        assert.ok(replies.length, 'no extra provider requests');
        return Response.json(replies.shift());
      });
      const result = await inferWithTools(
        nativeRoutes[format],
        messages,
        () => assert.fail('The tool budget is exhausted'),
        undefined,
        true,
        null,
        { priorCalls: chatToolCallLimit },
        sourceMessages,
      );
      assert.deepEqual(result, {
        text: 'The tool limit was reached. Review the completed actions before asking me to continue.',
        title: 'Launch plan review',
      });
      assert.equal(replies.length, 0);
      const titleRequest = requests.at(-1);
      assert.equal(titleRequest.tools, undefined);
      assert.match(JSON.stringify(conversation(format, titleRequest)), /Review our launch plan/);
      assert.doesNotMatch(JSON.stringify(titleRequest), /PRIVATE_FILE_CONTEXT|keep working|tool limit/);
    });

test('a no-progress stop still generates a title without repeating tools', async t => {
  let calls = 0;
  let titles = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.body.includes('Write a title for a new chat')) {
      titles++;
      return Response.json(nativeReply('anthropic', { text: 'Launch research' }));
    }
    return Response.json(nativeReply('anthropic', { calls: [use('web.fetch', { url: 'https://example.com/same' })] }));
  });
  const result = await inferWithTools(
    nativeRoutes.anthropic,
    [{ role: 'user', text: 'Research our launch' }],
    async () => {
      calls++;
      return { text: 'Unchanged' };
    },
    undefined,
    true,
  );
  assert.equal(result.title, 'Launch research');
  assert.match(result.text, /repeated tool requests/);
  assert.equal(calls, 4);
  assert.equal(titles, 1);
});

test('a separate title route sends and meters the title request with that model', async t => {
  const titleRoute = {
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com/',
    model: 'claude-haiku-synthetic',
    apiKey: 'synthetic-key',
    maxOutputTokens: 256,
  };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    if (isCompletionRequest(requests.at(-1).body)) return Response.json(completionReply('responses'));
    return Response.json(
      requests.length === 1
        ? nativeReply('responses', { text: 'Here are your resources.' })
        : nativeReply('anthropic', { text: 'Resource overview' }),
    );
  });
  const attempts = [];
  const result = await inferWithTools(
    nativeRoutes.responses,
    [{ role: 'user', text: 'List our resources' }],
    () => assert.fail('No tool expected'),
    async attempt => {
      attempts.push(attempt);
      return async () => {};
    },
    true,
    null,
    { earlierMessages: false, sources: () => [], titleRoute },
  );
  assert.deepEqual(result, { text: 'Here are your resources.', title: 'Resource overview' });
  assert.deepEqual(
    attempts.map(({ step, provider, model, maxOutputTokens }) => ({ step, provider, model, maxOutputTokens })),
    [
      { step: 0, provider: 'azure', model: 'gpt-6-astra', maxOutputTokens: 4096 },
      { step: 1, provider: 'azure', model: 'gpt-6-astra', maxOutputTokens: 4096 },
      { step: 2, provider: 'anthropic', model: 'claude-haiku-synthetic', maxOutputTokens: 256 },
    ],
  );
  assert.match(requests[2].url, /api\.anthropic\.com/);
  assert.equal(requests[2].body.model, 'claude-haiku-synthetic');
  assert.equal(requests[2].body.max_tokens, 256);
  assert.ok(JSON.stringify(requests[2].body.system).includes(JSON.stringify(titleSystemPrompt).slice(1, -1)));
});

test('title mistakes do not discard the answer and long Unicode titles truncate at whole characters', async t => {
  let title;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (isCompletionRequest(JSON.parse(options.body))) return Response.json(completionReply('anthropic'));
    if (!options.body.includes('Write a title for a new chat'))
      return Response.json(nativeReply('anthropic', { text: 'Useful answer' }));
    if (title instanceof Response) return title;
    return Response.json(typeof title === 'string' ? nativeReply('anthropic', { text: title }) : title);
  });
  for (title of [
    '',
    '  ',
    '\0',
    '\ud800',
    { stop_reason: 'end_turn', content: 'oops' },
    new Response('Busy', { status: 503 }),
  ]) {
    assert.deepEqual(
      await inferWithTools(
        nativeRoutes.anthropic,
        [{ role: 'user', text: 'Hello' }],
        () => assert.fail(),
        undefined,
        true,
      ),
      { text: 'Useful answer' },
    );
  }
  title = `  ${'👨‍👩‍👧‍👦'.repeat(51)}  `;
  assert.deepEqual(
    await inferWithTools(
      nativeRoutes.anthropic,
      [{ role: 'user', text: 'Hello' }],
      () => assert.fail(),
      undefined,
      true,
    ),
    { text: 'Useful answer', title: '👨‍👩‍👧‍👦'.repeat(50) },
  );
});
