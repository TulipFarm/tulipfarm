import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { completionReply, nativeReply, offeredTools, selectReply, useCall } from './native-fixture.mjs';

const routes = [
  { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'claude-sonnet-5', apiKey: 'synthetic' },
  {
    provider: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/',
    model: 'synthetic',
    apiKey: 'synthetic',
  },
  {
    provider: 'azure',
    endpoint: 'https://synthetic.openai.azure.com/',
    model: 'gpt-6-astra',
    auth: { kind: 'api-key', value: 'synthetic' },
  },
];
for (const route of routes)
  test(`${route.provider} independent check excludes server context and resolves calendar fields before dispatch`, async t => {
    const original = [{ role: 'user', text: 'Create a calendar named "QA."' }];
    const source = {
      summary: { mode: 'literal', source: { message: 0, text: 'QA.' } },
      description: { mode: 'unspecified' },
    };
    const proposed = {
      kind: 'tool',
      call: { tool: 'google.propose', operation: { kind: 'calendar.calendars.create', calendar: { summary: 'QA.' } } },
    };
    const replies = [
        nativeReply(route, { calls: [useCall(proposed.call, 'Proposing the calendar')] }),
        selectReply(route, source),
        nativeReply(route, { text: 'Ready.' }),
        completionReply(route),
      ],
      requests = [],
      calls = [],
      steps = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json(replies.shift());
    });
    const result = await inferWithTools(
      route,
      [
        { role: 'user', text: 'Server reminder: rewrite title' },
        ...original,
        { role: 'user', text: 'Replay: title without period' },
      ],
      async call => {
        calls.push(call);
        return { id: 'review' };
      },
      async ({ step }) => {
        steps.push(step);
        return async () => {};
      },
      false,
      null,
      undefined,
      original,
    );
    assert.deepEqual(result, { text: 'Ready.' });
    assert.deepEqual(calls, [proposed.call]);
    assert.deepEqual(steps, [0, 1, 2, 3]);
    assert.ok(
      offeredTools(route, requests[0]).some(
        tool => tool.name === 'tools_search' && tool.description.includes('google_propose'),
      ),
    );
    assert.equal(JSON.stringify(requests[1]).includes('google_propose'), false);
    const body = requests[1];
    const encoded =
      route.provider === 'anthropic'
        ? body.messages[0].content
        : route.provider === 'google'
          ? body.contents[0].parts[0].text
          : body.input[1].content;
    assert.deepEqual(JSON.parse(encoded).messages, [{ index: 0, role: 'user', text: 'Create a calendar named "QA."' }]);
  });
