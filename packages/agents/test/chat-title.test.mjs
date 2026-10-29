import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferChatTitle, inferWithTools } from '../src/inference.ts';
import { titleSystemPrompt } from '../src/prompts.ts';
import { completionReply, conversation, formats, nativeReply, nativeRoutes, use } from './native-fixture.mjs';

for (const format of formats) {
  test(`${format} replies never wait for a title request`, async t => {
    const requests = [];
    const replies = [
      nativeReply(format, { calls: [use('tables.definitions', {}, 'Listing your tables')] }),
      nativeReply(format, { text: 'Here are your resources.' }),
      completionReply(format),
    ];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      requests.push(JSON.parse(options.body));
      assert.ok(replies.length, 'no title request');
      return Response.json(replies.shift());
    });
    assert.deepEqual(
      await inferWithTools(nativeRoutes[format], [{ role: 'user', text: 'List our resources' }], async () => ({
        tables: [],
      })),
      { text: 'Here are your resources.' },
    );
    assert.equal(requests.length, 3);
    for (const request of requests) assert.doesNotMatch(JSON.stringify(request), /Write a title for a new chat/);

    requests.length = 0;
    replies.push(nativeReply(format, { text: 'Here are your resources.' }));
    assert.deepEqual(
      await inferWithTools(nativeRoutes[format], [{ role: 'user', text: 'List our resources' }], () =>
        assert.fail('No tool expected'),
      ),
      { text: 'Here are your resources.' },
    );
    assert.equal(requests.length, 1, 'a tool-free answer skips the completion check and the title');
  });

  test(`${format} titles a chat from the requester's message in one metered plain-text call`, async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json(nativeReply(format, { text: 'Resource overview' }));
    });
    const metered = [];
    assert.equal(
      await inferChatTitle(nativeRoutes[format], 'List our resources', async attempt => {
        metered.push(attempt.step);
        return async usage => metered.push(usage.kind);
      }),
      'Resource overview',
    );
    assert.deepEqual(metered, [0, 'known']);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tools, undefined);
    assert.ok(JSON.stringify(requests[0]).includes(JSON.stringify(titleSystemPrompt).slice(1, -1)));
    assert.match(JSON.stringify(conversation(format, requests[0])), /List our resources/);
  });
}

test('a title route sends the title request with that model', async t => {
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
    return Response.json(nativeReply('anthropic', { text: 'Resource overview' }));
  });
  const attempts = [];
  assert.equal(
    await inferChatTitle(titleRoute, 'List our resources', async attempt => {
      attempts.push(attempt);
      return async () => {};
    }),
    'Resource overview',
  );
  assert.deepEqual(
    attempts.map(({ step, provider, model, maxOutputTokens }) => ({ step, provider, model, maxOutputTokens })),
    [{ step: 0, provider: 'anthropic', model: 'claude-haiku-synthetic', maxOutputTokens: 256 }],
  );
  assert.match(requests[0].url, /api\.anthropic\.com/);
  assert.equal(requests[0].body.model, 'claude-haiku-synthetic');
  assert.equal(requests[0].body.max_tokens, 256);
  assert.ok(JSON.stringify(requests[0].body.system).includes(JSON.stringify(titleSystemPrompt).slice(1, -1)));
});

test('an unusable title is absent, a failed request throws, and long Unicode titles truncate at whole characters', async t => {
  let title;
  t.mock.method(globalThis, 'fetch', async () =>
    title instanceof Response
      ? title
      : Response.json(typeof title === 'string' ? nativeReply('anthropic', { text: title }) : title),
  );
  for (title of ['', '  ', '\0', '\ud800', { stop_reason: 'end_turn', content: 'oops' }])
    assert.equal(await inferChatTitle(nativeRoutes.anthropic, 'Hello'), undefined);
  title = new Response('Busy', { status: 503 });
  await assert.rejects(inferChatTitle(nativeRoutes.anthropic, 'Hello'), { message: 'model-unavailable' });
  title = `  ${'👨‍👩‍👧‍👦'.repeat(51)}  `;
  assert.equal(await inferChatTitle(nativeRoutes.anthropic, 'Hello'), '👨‍👩‍👧‍👦'.repeat(50));
});

test('a refused credit reservation stops the title before the provider is called', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No provider request'));
  await assert.rejects(
    inferChatTitle(nativeRoutes.anthropic, 'Hello', async () => {
      throw new Error('credits-exhausted');
    }),
    { message: 'credits-exhausted' },
  );
});

test('a title written as a Markdown document keeps its first line without heading marks, quotes or a period', async t => {
  let title;
  t.mock.method(globalThis, 'fetch', async () => Response.json(nativeReply('anthropic', { text: title })));
  for (const [text, expected] of [
    ['## Executive Summary\nMore detail follows.', 'Executive Summary'],
    ['\n\n  "Cache choice."  \nWhy Valkey', 'Cache choice'],
    ['**_Quarterly plan_**', 'Quarterly plan'],
  ]) {
    title = text;
    assert.equal(await inferChatTitle(nativeRoutes.anthropic, 'Hello'), expected);
  }
});
