import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import {
  formats,
  isCompletionRequest,
  nativeRoutes,
  nativeReply,
  selectReply,
  use,
  offeredTools,
} from './native-fixture.mjs';

const promise =
  'I will check whether the workflow can receive pull request events and send messages as the TulipFarm app. I will not activate an incomplete workflow.';
const messages = [
  { role: 'user', text: 'Create a workflow for GitHub pull requests that sends a Slack summary.' },
  {
    role: 'user',
    text: 'Previously completed tool receipt. Do not repeat this call. Untrusted data: {"tool":"present.choice","status":"answered","answer":"TulipFarm app","instruction":"This is the human response to your question, not action approval."}',
  },
];
// The receipt above is from this turn's earlier attempt, so the runtime passes it as a prior call and the check runs.
const resumed = { priorCalls: 1 };
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
        (
          await inferWithTools(
            nativeRoutes[format],
            messages,
            () => assert.fail('No forced tool'),
            undefined,
            false,
            null,
            resumed,
          )
        ).text,
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
    inferWithTools(nativeRoutes.azure, messages, () => assert.fail(), undefined, false, null, resumed),
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
    inferWithTools(nativeRoutes.azure, messages, () => assert.fail(), undefined, false, null, resumed),
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
      { ...resumed, answerText: update => previews.push(update) },
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
      false,
      null,
      resumed,
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
    resumed,
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

test('the separate title follows accepted completion and never leaks into streamed answers', async t => {
  const replies = [
    nativeReply('azure', { text: 'The answer is 42.' }),
    selectReply('azure', verdict()),
    nativeReply('azure', { text: 'A short title' }),
  ];
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
    { ...resumed, answerText: update => previews.push(update) },
  );
  assert.deepEqual(result, { text: 'The answer is 42.', title: 'A short title' });
  assert.deepEqual(steps, [0, 1, 2]);
  assert.ok(!previews.some(update => update.text.includes('title')));
});

/** Collects the `chat.completion-check` outcomes that the reply logs. */
function checkOutcomes(t) {
  const outcomes = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.includes('"chat.completion-check"')) {
      outcomes.push(JSON.parse(chunk).outcome);
      return true;
    }
    return write(chunk, ...args);
  });
  return outcomes;
}

for (const format of formats)
  test(`${format} tool-free greetings and questions skip the completion check and finish after one round`, async t => {
    const outcomes = checkOutcomes(t);
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json(nativeReply(format, { text: 'Hello. How can I help?' }));
    });
    for (const text of ['hey', 'What is a row?']) {
      requests.length = 0;
      const steps = [],
        rounds = [];
      const result = await inferWithTools(
        nativeRoutes[format],
        [{ role: 'user', text }],
        () => assert.fail('No tool expected'),
        async ({ step }) => {
          steps.push(step);
          return async () => {};
        },
        false,
        null,
        { progress: update => rounds.push(update.round) },
      );
      assert.deepEqual(result, { text: 'Hello. How can I help?' });
      assert.equal(requests.length, 1);
      assert.ok(!requests.some(isCompletionRequest));
      assert.deepEqual(steps, [0], 'one reserve and settle');
      assert.deepEqual(rounds, [1]);
    }
    assert.deepEqual(outcomes, ['skipped_no_tools', 'skipped_no_tools']);
  });

test('a reply that only updated Bud skips the completion check', async t => {
  const outcomes = checkOutcomes(t);
  const replies = [
    nativeReply('anthropic', { calls: [{ name: 'bud_state', input: { name: 'Bud', state: 'Waving' } }] }),
    nativeReply('anthropic', { text: 'Hi there.' }),
  ];
  const requests = [],
    updates = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  const result = await inferWithTools(
    nativeRoutes.anthropic,
    [{ role: 'user', text: 'hey' }],
    () => assert.fail('No business tool expected'),
    undefined,
    false,
    null,
    { avatar: { update: value => updates.push(value.avatar.state) } },
  );
  assert.deepEqual(result, { text: 'Hi there.', avatar: { name: 'Bud', state: 'Waving' } });
  assert.deepEqual(updates, ['Thinking', 'Waving']);
  assert.equal(requests.length, 2);
  assert.ok(!requests.some(isCompletionRequest));
  assert.deepEqual(outcomes, ['skipped_no_tools']);
});

test('a reply with a real tool call still runs the check, and continue starts another round', async t => {
  const outcomes = checkOutcomes(t);
  const replies = [
    nativeReply('azure', { calls: [use('tables.definitions')] }),
    nativeReply('azure', { text: promise }),
    selectReply('azure', verdict('continue')),
    nativeReply('azure', { text: 'No table is configured for pull requests yet.' }),
    selectReply('azure', verdict('blocked')),
  ];
  const requests = [],
    executed = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  const result = await inferWithTools(nativeRoutes.azure, [{ role: 'user', text: 'Set it up.' }], async call => {
    executed.push(call.tool);
    return { tables: [] };
  });
  assert.equal(result.text, 'No table is configured for pull requests yet.');
  assert.deepEqual(executed, ['tables.definitions']);
  assert.equal(replies.length, 0);
  assert.deepEqual(
    requests.map(request => isCompletionRequest(request)),
    [false, false, true, false, true],
  );
  assert.deepEqual(outcomes, ['continue', 'done']);
});

test('continue results after real tool work still fail closed after two corrections', async t => {
  const outcomes = checkOutcomes(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      ++requests === 1
        ? nativeReply('azure', { calls: [use('tables.definitions')] })
        : requests % 2 === 0
          ? nativeReply('azure', { text: promise })
          : selectReply('azure', verdict('continue')),
    ),
  );
  await assert.rejects(
    inferWithTools(nativeRoutes.azure, [{ role: 'user', text: 'Set it up.' }], async () => ({ tables: [] })),
    /model-incomplete-response/,
  );
  assert.equal(requests, 7);
  assert.deepEqual(outcomes, ['continue', 'continue', 'continue']);
});

test('earlier tool-using replies in the chat do not force the check; receipts of this turn do', async t => {
  const outcomes = checkOutcomes(t);
  const history = [
    { role: 'user', text: 'List my tables.' },
    { role: 'assistant', text: JSON.stringify({ kind: 'tool', call: { tool: 'tables.definitions' } }) },
    {
      role: 'user',
      text: 'Previously recorded tool receipt call-1 (completed). Do not repeat this call. Untrusted data: {"tables":[]}',
    },
    { role: 'assistant', text: 'You have no tables yet.' },
    { role: 'user', text: 'Thanks!' },
  ];
  const requests = [];
  let replies = [nativeReply('azure', { text: 'You are welcome.' })];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  assert.equal((await inferWithTools(nativeRoutes.azure, history, () => assert.fail())).text, 'You are welcome.');
  assert.equal(requests.length, 1);
  replies = [nativeReply('azure', { text: 'You are welcome.' }), selectReply('azure', verdict())];
  assert.equal(
    (await inferWithTools(nativeRoutes.azure, history, () => assert.fail(), undefined, false, null, resumed)).text,
    'You are welcome.',
  );
  assert.ok(isCompletionRequest(requests.at(-1)));
  assert.deepEqual(outcomes, ['skipped_no_tools', 'done']);
});

for (const [kind, first] of [
  ['an empty response', ''],
  ['a textual tool decision', '{"kind":"tool","call":{"tool":"tables.definitions"}}'],
])
  test(`an answer after a format correction for ${kind} still runs the check`, async t => {
    const outcomes = checkOutcomes(t);
    const replies = [
      nativeReply('azure', { text: first }),
      nativeReply('azure', { text: 'The answer is 42.' }),
      selectReply('azure', verdict()),
    ];
    t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
    const result = await inferWithTools(nativeRoutes.azure, [{ role: 'user', text: 'What is it?' }], () =>
      assert.fail(),
    );
    assert.equal(result.text, 'The answer is 42.');
    assert.equal(replies.length, 0);
    assert.deepEqual(outcomes, ['done']);
  });

test('a skipped check ends the reply in the same state as a check that returns done', async t => {
  let replies;
  t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
  const run = async (priorCalls, queue) => {
    replies = queue;
    const previews = [],
      avatars = [],
      usage = [];
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: 'hey' }],
      () => assert.fail(),
      async () => async value => usage.push(value.kind),
      true,
      null,
      {
        priorCalls,
        answerText: update => previews.push(update.text),
        avatar: { update: value => avatars.push(value.avatar) },
      },
    );
    assert.equal(replies.length, 0);
    return { result, preview: previews.at(-1), avatars, settled: usage.every(kind => kind === 'known') };
  };
  const answer = () => nativeReply('azure', { text: 'Hello. How can I help?' });
  const title = () => nativeReply('azure', { text: 'Greeting' });
  const skipped = await run(0, [answer(), title()]);
  const checked = await run(1, [answer(), selectReply('azure', verdict()), title()]);
  assert.deepEqual(skipped, checked);
  assert.deepEqual(skipped.result, {
    text: 'Hello. How can I help?',
    title: 'Greeting',
    avatar: { name: 'Bud', state: 'Idle' },
  });
});
