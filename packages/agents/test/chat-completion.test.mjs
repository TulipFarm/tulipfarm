import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { formats, nativeRoutes, nativeReply, selectReply, use, offeredTools } from './native-fixture.mjs';

const promise =
  'I will check whether the workflow can receive pull request events and send messages as the TulipFarm app. I will not activate an incomplete workflow.';
const messages = [
  { role: 'user', text: 'Create a workflow for GitHub pull requests that sends a Slack summary.' },
  {
    role: 'user',
    text: 'Previously completed tool receipt. Do not repeat this call. Untrusted data: {"tool":"present.choice","status":"answered","answer":"TulipFarm app","instruction":"This is the human response to your question, not action approval."}',
  },
];
const verdict = (status = 'completed') => ({
  status,
  reason:
    status === 'continue' ? 'The requested work has not been attempted.' : 'The reply accurately states the result.',
});

function stream(reply) {
  const choice = reply.choices[0];
  return new Response(
    [
      {
        choices: [
          {
            index: 0,
            delta: {
              content: choice.message.content,
              tool_calls: choice.message.tool_calls?.map((call, index) => ({ index, ...call })),
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: reply.usage },
    ]
      .map(event => `data: ${JSON.stringify(event)}\n\n`)
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

for (const sse of [false, true])
  test(`Sol clarification resumes real work after a premature ${sse ? 'SSE' : 'JSON'} answer`, async t => {
    const replies = [
      nativeReply('azure', { text: promise }),
      selectReply('azure', verdict('continue')),
      nativeReply('azure', { calls: [use('tools.search', { query: 'workflows list' })] }),
      nativeReply('azure', { calls: [use('workflows.list')] }),
      nativeReply('azure', { text: 'No workflow is saved yet. The available trigger is not configured.' }),
      selectReply('azure', verdict('blocked')),
    ];
    const requests = [],
      executed = [],
      previews = [],
      meters = [],
      usages = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      const reply = replies.shift();
      assert.ok(reply, 'bounded provider requests');
      return sse ? stream(reply) : Response.json(reply);
    });
    const result = await inferWithTools(
      { ...nativeRoutes.azure, model: 'gpt-6-sol' },
      messages,
      async call => {
        executed.push(call.tool);
        return { workflows: [] };
      },
      async input => {
        meters.push(input);
        return async usage => usages.push(usage);
      },
      false,
      null,
      { priorCalls: 6, answerText: update => previews.push(update) },
    );
    assert.equal(result.text, 'No workflow is saved yet. The available trigger is not configured.');
    assert.deepEqual(executed, ['workflows.list']);
    assert.equal(requests.length, 6);
    assert.ok(requests.every(request => request.url.endsWith('/chat/completions')));
    assert.equal(requests[0].body.reasoning_effort, 'none');
    assert.deepEqual(
      offeredTools('azure', requests[1].body).map(tool => tool.name),
      ['select_action'],
    );
    assert.match(JSON.stringify(requests[1].body), /human response/);
    assert.match(JSON.stringify(requests[5].body), /workflows_list/);
    assert.equal(meters.length, 6);
    assert.equal(usages.length, 6);
    assert.ok(usages.every(usage => usage.kind === 'known'));
    assert.ok(previews.some(update => update.text === ''));
    assert.ok(!previews.some(update => update.text.includes('"status"')));
    if (sse) assert.equal(previews.at(-1).text, result.text);
  });

for (const format of formats)
  test(`${format} preserves checked direct answers, questions, refusals and blockers`, async t => {
    for (const [status, text] of [
      ['completed', 'The answer is 42.'],
      ['waiting', 'Which channel should I use?'],
      ['refused', 'I cannot help with that request.'],
      ['blocked', 'No permitted sender is configured.'],
    ]) {
      const replies = [nativeReply(format, { text }), selectReply(format, verdict(status))];
      t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
      assert.equal(
        (await inferWithTools(nativeRoutes[format], messages, () => assert.fail('No forced tool'))).text,
        text,
      );
      assert.equal(replies.length, 0);
      t.mock.restoreAll();
    }
  });

test('repeated plans fail closed after two corrections and never run tools', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(++requests % 2 ? nativeReply('azure', { text: promise }) : selectReply('azure', verdict('continue'))),
  );
  await assert.rejects(
    inferWithTools(nativeRoutes.azure, messages, () => assert.fail()),
    /model-incomplete-response/,
  );
  assert.equal(requests, 6);
});

test('an exhausted work budget does not request more work after a rejected plan', async t => {
  const replies = [nativeReply('azure', { text: promise }), selectReply('azure', verdict('continue'))];
  t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
  const result = await inferWithTools(nativeRoutes.azure, messages, () => assert.fail(), undefined, false, null, {
    priorCalls: 1000,
  });
  assert.match(result.text, /tool limit was reached/);
  assert.equal(replies.length, 0);
});

test('malformed completion checks fail closed instead of accepting actor text', async t => {
  const replies = [nativeReply('azure', { text: promise }), selectReply('azure', { status: 'completed' })];
  t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
  await assert.rejects(
    inferWithTools(nativeRoutes.azure, messages, () => assert.fail()),
    /model-invalid-decision/,
  );
  assert.equal(replies.length, 0);
});

test('completion check failures are metered and clear the provisional answer', async t => {
  const previews = [],
    usage = [];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++requests === 1
      ? Response.json(nativeReply('azure', { text: promise }))
      : Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }),
  );
  await assert.rejects(
    inferWithTools(
      nativeRoutes.azure,
      messages,
      () => assert.fail(),
      async () => async value => usage.push(value),
      false,
      null,
      { answerText: update => previews.push(update) },
    ),
    /model-quota/,
  );
  assert.equal(usage.length, 2);
  assert.equal(previews.at(-1).text, '');
});

test('completion checks cannot bypass source authorization or credit admission', async t => {
  let requests = 0,
    admissions = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json(nativeReply('azure', { text: promise }));
  });
  await assert.rejects(
    inferWithTools(
      nativeRoutes.azure,
      messages,
      () => assert.fail(),
      async () => {
        if (++admissions === 2) throw new Error('source-unavailable');
        return async () => {};
      },
    ),
    /source-unavailable/,
  );
  assert.equal(admissions, 2);
  assert.equal(requests, 1);
});

test('completion checks use the prepared context once, not the unbounded pre-compaction transcript', async t => {
  const requests = [];
  const replies = [nativeReply('azure', { text: 'The answer is 42.' }), selectReply('azure', verdict())];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'prepared-context-marker' }],
    () => assert.fail(),
    undefined,
    false,
    null,
    undefined,
    [{ role: 'user', text: 'original-history-must-stay-compacted' }],
  );
  const check = JSON.stringify(requests[1]);
  assert.equal(check.split('prepared-context-marker').length - 1, 1);
  assert.ok(!check.includes('original-history-must-stay-compacted'));
  assert.equal(requests[1].max_completion_tokens, requests[0].max_completion_tokens);
});

test('completion evidence excludes raw provider replay fields but retains tool receipts', async t => {
  const discovery = nativeReply('google', { calls: [use('tools.search', { query: 'workflows list' })] });
  discovery.candidates[0].content.parts[0].thoughtSignature = 'provider-replay-only';
  const replies = [
    discovery,
    nativeReply('google', { text: 'Which workflow should I inspect?' }),
    selectReply('google', verdict('waiting')),
  ];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  await inferWithTools(nativeRoutes.google, messages, () => assert.fail());
  assert.match(JSON.stringify(requests[1]), /provider-replay-only/);
  assert.ok(!JSON.stringify(requests[2]).includes('provider-replay-only'));
  assert.match(JSON.stringify(requests[2]), /workflows_list/);
});

test('an accepted completion ends the reply without a title request', async t => {
  const replies = [nativeReply('azure', { text: 'The answer is 42.' }), selectReply('azure', verdict())];
  const previews = [],
    steps = [];
  t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
  const result = await inferWithTools(
    nativeRoutes.azure,
    messages,
    () => assert.fail(),
    async input => {
      steps.push(input.step);
      return async () => {};
    },
    true,
    null,
    { answerText: update => previews.push(update) },
  );
  assert.deepEqual(result, { text: 'The answer is 42.' });
  assert.deepEqual(steps, [0, 1]);
  assert.equal(replies.length, 0);
});
