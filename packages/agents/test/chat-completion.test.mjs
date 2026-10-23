import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionCheckEvidence, inferWithTools } from '../src/inference.ts';
import { completionEvaluation, evaluationMessages } from './completion-evaluation-fixture.mjs';
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
      { ...resumed, completionCheck: nativeRoutes.anthropic },
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
  const evidence = JSON.parse(requests[1].messages.at(-1).content);
  assert.ok(!('context' in evidence), 'the runtime reminder is not repeated in the check');
  assert.equal(requests[1].max_completion_tokens, 384);
  assert.equal(requests[0].max_completion_tokens, 4096);
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
    { ...resumed, answerText: update => previews.push(update) },
  );
  assert.deepEqual(result, { text: 'The answer is 42.' });
  assert.deepEqual(steps, [0, 1]);
  assert.equal(replies.length, 0);
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
      assert.deepEqual([...new Set(rounds)], [1], 'one model round');
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

test('completion evidence retains all requests, clarifications, inputs and receipts without provider replay', () => {
  const input = { activity: 'Querying records', filter: { status: 'open' } };
  const output = JSON.stringify({ rows: ['x'.repeat(20_000)], error: 'important error at the end' });
  const items = [
    { kind: 'turn', turn: { role: 'user', text: 'List every open incident and owner.' } },
    { kind: 'turn', turn: { role: 'assistant', text: 'Which project?' } },
    { kind: 'turn', turn: { role: 'user', text: 'The support project.' } },
    {
      kind: 'model',
      text: 'Reading the records.',
      calls: [{ id: 'call-1', name: 'tables_query', input, providerId: true }],
      raw: { replay: 'provider-only'.repeat(1000) },
    },
    {
      kind: 'results',
      results: [{ id: 'call-1', name: 'tables_query', output, error: true, providerId: true }],
    },
  ];
  const serialized = completionCheckEvidence(items, 'There are no incidents.', 4);
  const evidence = JSON.parse(serialized);
  assert.deepEqual(evidence.history.slice(0, 3), items.slice(0, 3));
  assert.deepEqual(evidence.history[3].calls, [{ id: 'call-1', name: 'tables_query', input }]);
  assert.deepEqual(evidence.history[4].results, [{ id: 'call-1', name: 'tables_query', output, error: true }]);
  assert.equal(evidence.candidate, 'There are no incidents.');
  assert.equal(evidence.workBudgetRemaining, 4);
  assert.ok(!serialized.includes('provider-only'));
  assert.ok(!serialized.includes('providerId'));
  assert.equal(JSON.parse(completionCheckEvidence(items, 'Budget spent.', 0)).workBudgetRemaining, 0);
});

for (const format of formats)
  test(`${format} uses a separate completion route and meters its bounded output without changing the reply route`, async t => {
    const requests = [],
      meters = [];
    const replies = [
      nativeReply('azure', { text: promise }),
      selectReply(format, verdict('continue')),
      nativeReply('azure', { text: 'No permitted sender is configured.' }),
      selectReply(format, verdict('blocked')),
    ];
    const completionCheck = { ...nativeRoutes[format], maxOutputTokens: 300 };
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json(replies.shift());
    });
    const result = await inferWithTools(
      nativeRoutes.azure,
      messages,
      () => assert.fail('No forced tool'),
      async attempt => {
        meters.push(attempt);
        return async () => {};
      },
      false,
      null,
      { ...resumed, completionCheck },
    );
    assert.equal(result.text, 'No permitted sender is configured.');
    assert.deepEqual(
      meters.map(({ model }) => model),
      [nativeRoutes.azure.model, completionCheck.model, nativeRoutes.azure.model, completionCheck.model],
    );
    assert.deepEqual(
      meters.map(({ maxOutputTokens }) => maxOutputTokens),
      [4096, 300, 4096, 300],
    );
    assert.equal(requests[1].body.model ?? completionCheck.model, completionCheck.model);
    assert.equal(replies.length, 0);
  });

test('completion checks keep the active chat model by default and disable reasoning only with its capability', async t => {
  const requests = [];
  const replies = [nativeReply('azure', { text: 'Finished.' }), selectReply('azure', verdict())];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  await inferWithTools(
    { ...nativeRoutes.azure, model: 'gpt-6-sol' },
    messages,
    () => assert.fail(),
    undefined,
    false,
    null,
    resumed,
  );
  assert.deepEqual(
    requests.map(({ model }) => model),
    ['gpt-6-sol', 'gpt-6-sol'],
  );
  assert.equal(requests[1].reasoning_effort, 'none');
  assert.equal(requests[1].max_completion_tokens, 384);
});

test('a completion check without its own role follows the active fallback model', async t => {
  const models = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    models.push(request.model);
    if (models.length === 1) return Response.json({ error: { code: 'DeploymentNotFound' } }, { status: 404 });
    return Response.json(
      isCompletionRequest(request)
        ? selectReply('anthropic', verdict())
        : nativeReply('anthropic', { text: 'The answer is 42.' }),
    );
  });
  const result = await inferWithTools(nativeRoutes.azure, messages, () => assert.fail(), undefined, false, null, {
    ...resumed,
    fallback: { route: nativeRoutes.anthropic, label: 'synthetic-fallback' },
  });
  assert.equal(result.fallback, 'synthetic-fallback');
  assert.deepEqual(models, [nativeRoutes.azure.model, nativeRoutes.anthropic.model, nativeRoutes.anthropic.model]);
});

test('completion output cut off by the provider fails closed', async t => {
  const outcomes = checkOutcomes(t);
  const truncated = selectReply('azure', verdict());
  truncated.choices[0].finish_reason = 'length';
  const replies = [nativeReply('azure', { text: 'Finished.' }), truncated];
  t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
  await assert.rejects(
    inferWithTools(nativeRoutes.azure, messages, () => assert.fail(), undefined, false, null, resumed),
    /model-output-limit/,
  );
  assert.deepEqual(outcomes, ['error']);
});

test('completion input is smaller on the synthetic evaluation without losing request or receipt evidence', async t => {
  const sizes = [];
  for (const example of completionEvaluation) {
    const requests = [];
    const replies = [nativeReply('azure', { text: example.candidate }), selectReply('azure', verdict())];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json(replies.shift());
    });
    await inferWithTools(
      nativeRoutes.azure,
      evaluationMessages(example),
      () => assert.fail(),
      undefined,
      false,
      null,
      resumed,
    );
    const evidence = requests[1].messages.at(-1).content;
    const oldEvidence = JSON.stringify({
      context: requests[0].messages[1].content,
      ...JSON.parse(evidence),
    });
    const before = Buffer.byteLength(oldEvidence);
    const after = Buffer.byteLength(evidence);
    assert.ok(after < before / 4, example.name);
    sizes.push({ case: example.name, before, after });
    t.mock.restoreAll();
  }
  t.diagnostic(`Synthetic completion-evidence bytes (same turns and receipts): ${JSON.stringify(sizes)}`);
});

for (const value of [
  { status: 'done', reason: 'Unsupported status' },
  { status: 'completed', reason: '' },
  { status: 'completed', reason: 'x'.repeat(241) },
  { status: 'completed', reason: 'OK', extra: true },
  null,
])
  test(`invalid completion output fails closed: ${JSON.stringify(value)?.slice(0, 60)}`, async t => {
    const outcomes = checkOutcomes(t);
    const replies = [nativeReply('azure', { text: 'Finished.' }), selectReply('azure', value)];
    t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
    await assert.rejects(
      inferWithTools(nativeRoutes.azure, messages, () => assert.fail(), undefined, false, null, resumed),
      /model-invalid-decision/,
    );
    assert.deepEqual(outcomes, ['error']);
  });

test('synthetic evaluation replays expected decisions without heuristically accepting unfinished replies', async t => {
  for (const example of completionEvaluation) {
    const outcomes = checkOutcomes(t);
    const requests = [];
    const replies = [
      nativeReply('azure', { text: example.candidate }),
      selectReply('azure', { status: example.status, reason: example.name }),
      ...(example.status === 'continue'
        ? [
            nativeReply('azure', { text: 'Which missing input should I use to finish?' }),
            selectReply('azure', { status: 'waiting', reason: 'A necessary input is missing.' }),
          ]
        : []),
    ];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json(replies.shift());
    });
    const result = await inferWithTools(
      nativeRoutes.azure,
      evaluationMessages(example),
      () => assert.fail('No tool should run in decision replay'),
      undefined,
      false,
      null,
      resumed,
    );
    const evidence = JSON.parse(requests[1].messages.at(-1).content);
    assert.equal(evidence.candidate, example.candidate, example.name);
    assert.ok(JSON.stringify(evidence).includes(example.request), example.name);
    assert.ok(JSON.stringify(evidence).includes(example.tool), example.name);
    if (example.clarification) assert.ok(JSON.stringify(evidence).includes(example.clarification), example.name);
    assert.equal(outcomes[0], example.status === 'continue' ? 'continue' : 'done', example.name);
    assert.equal(
      result.text,
      example.status === 'continue' ? 'Which missing input should I use to finish?' : example.candidate,
      example.name,
    );
    assert.equal(replies.length, 0, example.name);
    t.mock.restoreAll();
  }
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
  const skipped = await run(0, [answer()]);
  const checked = await run(1, [answer(), selectReply('azure', verdict())]);
  assert.deepEqual(skipped, checked);
  assert.deepEqual(skipped.result, {
    text: 'Hello. How can I help?',
    avatar: { name: 'Bud', state: 'Idle' },
  });
});
