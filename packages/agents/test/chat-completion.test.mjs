import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardClaims,
  claimsActionOutcome,
  completionCheckEvidence,
  inferWithTools,
  noCardReply,
  unbackedCardClaim,
  unbackedImportClaim,
  unbackedWriteClaim,
} from '../src/inference.ts';
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

test('a malformed completion check delivers the answer instead of failing the turn', async t => {
  const outcomes = checkOutcomes(t);
  const replies = [nativeReply('azure', { text: promise }), selectReply('azure', { status: 'completed' })];
  t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
  const result = await inferWithTools(
    nativeRoutes.azure,
    messages,
    () => assert.fail(),
    undefined,
    false,
    null,
    resumed,
  );
  assert.equal(result.text, promise);
  assert.equal(replies.length, 0);
  assert.deepEqual(outcomes, ['error']);
});

test('completion check provider failures are metered and keep the answer', async t => {
  const outcomes = checkOutcomes(t);
  const previews = [],
    usage = [];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++requests === 1
      ? Response.json(nativeReply('azure', { text: promise }))
      : Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }),
  );
  const result = await inferWithTools(
    nativeRoutes.azure,
    messages,
    () => assert.fail(),
    async () => async value => usage.push(value),
    false,
    null,
    { ...resumed, answerText: update => previews.push(update) },
  );
  assert.equal(result.text, promise);
  assert.equal(usage.length, 2);
  assert.ok(!previews.some(update => update.text === ''));
  assert.deepEqual(outcomes, ['error']);
});

test('an aborted completion check still fails the turn', async t => {
  const controller = new AbortController();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++requests === 1) return Response.json(nativeReply('azure', { text: promise }));
    controller.abort(new Error('turn-cancelled'));
    throw controller.signal.reason;
  });
  await assert.rejects(
    inferWithTools(nativeRoutes.azure, messages, () => assert.fail(), undefined, false, null, {
      ...resumed,
      signal: controller.signal,
    }),
    /turn-cancelled/,
  );
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
  assert.equal(requests[1].max_completion_tokens, 4096);
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

test('a reply that reports an action outcome is checked even without a tool call', () => {
  for (const text of [
    'A review card is ready for you to approve the new orders table with the specified fields and CSV import.',
    'The semicolon CSV import was denied.',
    '8 rows created in the migrate table.',
    'I created 8 rows.',
    'I’ve proposed version 3 of the table.',
    'Your changes are ready for your review.',
    'One row is now added to the Market Forest Stock table.',
    'Lime 10 and Lemon 5 were successfully created.',
    'Two rows have now been added.',
    'Added one row.',
    'Created two records.',
    'Added Lime 10 to the table.',
  ])
    assert.equal(claimsActionOutcome(text), true, text);
  for (const text of [
    'Hello. How can I help?',
    'You are welcome.',
    'A row is one item in a table.',
    'No rows have been added yet.',
    'None of the rows were added.',
    'Nothing was imported.',
    '0 rows added.',
    'Created by Dhruv, this table tracks stock.',
  ])
    assert.equal(claimsActionOutcome(text), false, text);
});

test('a write claim with no write in this reply is sent back without the completion model', () => {
  for (const text of [
    'One row is now added to the Market Forest Stock table.',
    'Added one row.',
    'Two rows were successfully created in the table.',
    'Done — 3 entries saved.',
  ]) {
    assert.equal(unbackedWriteClaim(text, false)?.status, 'continue', text);
    assert.ok(unbackedWriteClaim(text, false).reason.length <= 240, text);
    assert.equal(unbackedWriteClaim(text, true), undefined, text);
  }
  for (const text of [
    'No rows have been added yet.',
    'No table named migrate exists, so I added no rows.',
    'The 9 rows were added earlier, when you approved the card.',
    'The rows were added after you approved the card.',
    'Should I add the row to the table?',
    'Once you approve the card, the row will be added.',
    'The approval card was created for 9 rows.',
  ])
    assert.equal(unbackedWriteClaim(text, false), undefined, text);
});

test('an import presented for review needs a pending proposal receipt from this reply', () => {
  const pending = [
    {
      kind: 'results',
      results: [{ id: 'p', name: 'tables_propose', output: '{"id":"x","status":"pending"}', error: false }],
    },
  ];
  const failed = [
    {
      kind: 'results',
      results: [{ id: 'p', name: 'tables_propose', output: '{"error":"import-values-invalid"}', error: false }],
    },
  ];
  for (const text of [
    'I prepared the import of 10 orders and will send it for human review.',
    'Here is the import review: 10 rows will be added. Do you confirm this import?',
    'The import review card is ready below.',
  ]) {
    assert.equal(unbackedImportClaim(text, [])?.status, 'continue', text);
    assert.equal(unbackedImportClaim(text, failed)?.status, 'continue', text);
    assert.equal(unbackedImportClaim(text, pending), undefined, text);
  }
  for (const text of [
    'No import review was created: row 2 has "Pending", which isn’t a Status option.',
    'Which file should I import?',
  ])
    assert.equal(unbackedImportClaim(text, []), undefined, text);
});

test('a reply that presents an approval or review card needs a tool result in this reply that made one', () => {
  const results = (name, output, error = false) => [
    { kind: 'results', results: [{ id: 'c', name, output: `Untrusted tool result for x: ${output}`, error }] },
  ];
  const draft = results('rows_create', '{"draftId":"d","status":"review-required","operation":"create"}');
  const proposal = results('tables_propose', '{"id":"p","status":"pending"}');
  const written = results('rows_create', '{"record":{"id":"r","values":{}}}');
  const held = results('rows_create_batch', '{"error":"review-required","reason":"too-many-rows"}');
  for (const text of [
    'I have prepared the first row but have no approval yet. Please approve the pending row creation card, then tell me to continue.',
    'I have prepared the first row for approval. The chat card for qa-rv5-m1 should now appear above this message.',
    'Please approve the card in the interface to add the rows.',
    'Five approval cards are ready.',
    'Your import is ready for review. Open the import review to approve it.',
    'The rows are waiting for your approval.',
    'I cannot create any rows until you approve the pending review card.',
  ]) {
    assert.ok(cardClaims(text).length, text);
    for (const items of [[], written, held]) assert.equal(unbackedCardClaim(text, items)?.status, 'continue', text);
    assert.equal(unbackedCardClaim(text, draft), undefined, text);
    assert.equal(unbackedCardClaim(text, proposal), undefined, text);
  }
  for (const text of [
    'No approval card was created because the batch exceeded the 5-row limit.',
    'I couldn’t create an approval card for these rows.',
    'Should I prepare an approval card for the 9 rows?',
    'The card I prepared earlier is still waiting above.',
    '3 rows added in Contacts.',
    'A card in Kanban view shows one row.',
  ])
    assert.deepEqual(cardClaims(text), [], text);
});

test('a reply that keeps claiming a card no tool made ends with a plain account instead', async t => {
  const outcomes = checkOutcomes(t);
  const claim = 'The approval card for the 9 rows should now appear above this message.';
  const replies = [
    nativeReply('azure', { text: claim }),
    nativeReply('azure', { text: claim }),
    nativeReply('azure', { text: 'Please approve the pending row creation card.' }),
  ];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create the approval card for all 9 rows.' }],
    () => assert.fail('No tool expected'),
  );
  assert.equal(result.text, noCardReply());
  assert.equal(replies.length, 0);
  assert.ok(!requests.some(isCompletionRequest));
  assert.match(JSON.stringify(requests[1].messages), /no tool call in this reply created one/);
  assert.deepEqual(outcomes, ['continue', 'continue', 'continue']);
});

test('an unbacked import review is sent back without the completion model until a proposal exists', async t => {
  const outcomes = checkOutcomes(t);
  const replies = [
    nativeReply('azure', { text: 'Here is the import review. Do you confirm this import?' }),
    nativeReply('azure', { calls: [use('tables.propose', { input: '{"plans":[]}' })] }),
    nativeReply('azure', { text: 'The import review card is ready below.' }),
    selectReply('azure', verdict('waiting')),
  ];
  const requests = [],
    executed = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Import orders.csv into Orders.' }],
    async call => {
      executed.push(call.tool);
      return { id: '00000000-0000-4000-8000-000000000001', status: 'pending' };
    },
  );
  assert.equal(result.text, 'The import review card is ready below.');
  assert.deepEqual(executed, ['tables.propose']);
  assert.deepEqual(
    requests.map(request => isCompletionRequest(request)),
    [false, false, false, true],
  );
  assert.match(JSON.stringify(requests[1].messages), /no tables\.propose call in this reply returned a pending review/);
  assert.deepEqual(outcomes, ['continue', 'done']);
});

test('a tool-free reply that claims rows were created is sent back to do the work', async t => {
  const outcomes = checkOutcomes(t);
  const replies = [
    nativeReply('azure', { text: '8 rows created.' }),
    nativeReply('azure', { calls: [use('tables.definitions')] }),
    nativeReply('azure', { text: 'No table named migrate exists, so I added no rows.' }),
    selectReply('azure', verdict('blocked')),
  ];
  const requests = [],
    executed = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Add 8 rows to the migrate table.' }],
    async call => {
      executed.push(call.tool);
      return { tables: [] };
    },
  );
  assert.equal(result.text, 'No table named migrate exists, so I added no rows.');
  assert.deepEqual(executed, ['tables.definitions']);
  assert.equal(replies.length, 0);
  assert.deepEqual(requests.map(isCompletionRequest), [false, false, false, true]);
  assert.match(JSON.stringify(requests[1].messages), /no tool call in this reply wrote any/);
  assert.deepEqual(outcomes, ['continue', 'done']);
});

test('a reply that claims an outcome is not delivered when its check fails', async t => {
  const outcomes = checkOutcomes(t);
  const replies = [
    nativeReply('azure', { text: 'The semicolon CSV import was denied.' }),
    selectReply('azure', null),
    nativeReply('azure', { text: 'I have not imported or denied anything yet. Which file should I import?' }),
    selectReply('azure', verdict('waiting')),
  ];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  const result = await inferWithTools(nativeRoutes.azure, [{ role: 'user', text: 'Import the semicolon CSV.' }], () =>
    assert.fail('No tool expected'),
  );
  assert.equal(result.text, 'I have not imported or denied anything yet. Which file should I import?');
  assert.equal(replies.length, 0);
  assert.match(JSON.stringify(requests[2].messages), /could not be checked/);
  assert.deepEqual(outcomes, ['error', 'done']);
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
  assert.equal(requests[1].max_completion_tokens, requests[0].max_completion_tokens);
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

test('completion output cut off by the provider delivers the finished answer', async t => {
  const outcomes = checkOutcomes(t);
  const truncated = selectReply('azure', verdict());
  truncated.choices[0].finish_reason = 'length';
  const replies = [nativeReply('azure', { text: 'Finished.' }), truncated];
  t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
  const result = await inferWithTools(
    nativeRoutes.azure,
    messages,
    () => assert.fail(),
    undefined,
    false,
    null,
    resumed,
  );
  assert.equal(result.text, 'Finished.');
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
  test(`invalid completion output delivers the answer: ${JSON.stringify(value)?.slice(0, 60)}`, async t => {
    const outcomes = checkOutcomes(t);
    const replies = [nativeReply('azure', { text: 'Finished.' }), selectReply('azure', value)];
    t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
    const result = await inferWithTools(
      nativeRoutes.azure,
      messages,
      () => assert.fail(),
      undefined,
      false,
      null,
      resumed,
    );
    assert.equal(result.text, 'Finished.');
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

test('completion evidence is trimmed oldest first to fit, keeping the latest request and the candidate', () => {
  const old = 'old context '.repeat(2000);
  const items = [
    { kind: 'turn', turn: { role: 'user', text: `First question. ${old}` } },
    { kind: 'turn', turn: { role: 'assistant', text: `First answer. ${old}` } },
    { kind: 'turn', turn: { role: 'user', text: 'Count the open incidents.' } },
    ...Array.from({ length: 6 }, (_, index) => [
      { kind: 'model', text: '', calls: [{ id: `call-${index}`, name: 'tables_query', input: {}, providerId: true }] },
      {
        kind: 'results',
        results: [
          { id: `call-${index}`, name: 'tables_query', output: `rows-${index} ${'x'.repeat(30_000)}`, error: false },
        ],
      },
    ]).flat(),
  ];
  const whole = completionCheckEvidence(items, 'There are 4 open incidents.', 3);
  assert.equal(completionCheckEvidence(items, 'There are 4 open incidents.', 3, whole.length), whole);
  // Results are cut to previews first.
  const previews = JSON.parse(completionCheckEvidence(items, 'There are 4 open incidents.', 3, 40_000));
  assert.equal(previews.history.length, items.length);
  assert.ok(
    previews.history.filter(item => item.kind === 'results').every(item => item.results[0].output.length < 500),
  );
  assert.match(previews.history.at(-1).results[0].output, /^rows-5 x+… \[cut from 30007 characters\]$/);
  // Then the oldest entries go, except the person's latest request.
  for (const max of [4000, 1500]) {
    const serialized = completionCheckEvidence(items, 'There are 4 open incidents.', 3, max);
    assert.ok(Buffer.byteLength(serialized) <= max, `${Buffer.byteLength(serialized)} <= ${max}`);
    const evidence = JSON.parse(serialized);
    assert.equal(evidence.history[0].kind, 'omitted');
    assert.ok(evidence.history.some(item => item.turn?.text === 'Count the open incidents.'));
    assert.ok(!serialized.includes('First question'));
    assert.equal(evidence.candidate, 'There are 4 open incidents.');
    assert.equal(evidence.workBudgetRemaining, 3);
  }
  // Even a request and candidate larger than the budget are cut rather than refused.
  const huge = 'y'.repeat(50_000);
  const cut = completionCheckEvidence([{ kind: 'turn', turn: { role: 'user', text: huge } }], huge, 0, 4096);
  assert.ok(Buffer.byteLength(cut) <= 4096);
  assert.ok(JSON.parse(cut).candidate.startsWith('yyy'));
});

test('the completion check request stays within its model window however long the reply grew', async t => {
  const window = 16000;
  let rounds = 0;
  let checked;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) {
      checked = init.body.length;
      return Response.json(selectReply('anthropic', verdict()));
    }
    rounds++;
    if (rounds <= 3)
      return Response.json(
        nativeReply('azure', { calls: [use('tables.definitions', {}, 'Reading', { id: `t${rounds}` })] }),
      );
    return Response.json(nativeReply('azure', { text: 'Done.' }));
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: `Describe the tables. ${'context '.repeat(8000)}` }],
    async () => ({ tables: ['z'.repeat(40_000)] }),
    undefined,
    false,
    null,
    { completionCheck: nativeRoutes.anthropic, completionCheckWindow: window },
  );
  assert.equal(result.text, 'Done.');
  assert.ok(Math.ceil(checked / 4) < window * 0.9, `${Math.ceil(checked / 4)} estimated tokens`);
});

test('while an earlier card still waits, a reply may point to it but not claim it made a new one', () => {
  const undecided = [
    {
      kind: 'results',
      results: [
        {
          id: 'c',
          name: 'rows_create',
          output: 'Untrusted tool result for x: {"error":"approval-pending"}',
          error: false,
        },
      ],
    },
  ];
  for (const text of [
    'The review card is still waiting for your approval.',
    'Yes. The review card for the 9 rows is ready. Approve it to write the rows.',
    'A row change for Contacts is already waiting for approval on a card. Approve or dismiss that card first.',
  ]) {
    assert.equal(unbackedCardClaim(text, [])?.status, 'continue', text);
    assert.equal(unbackedCardClaim(text, [], 1), undefined, text);
    assert.equal(unbackedCardClaim(text, undecided), undefined, text);
  }
  for (const text of [
    'I prepared a new review card for the Lime row.',
    'A review card for the Lime 10 row now waits in the chat.',
    'The approval card for Lime should now appear above this message.',
  ]) {
    assert.equal(unbackedCardClaim(text, [], 1)?.status, 'continue', text);
    assert.equal(unbackedCardClaim(text, undecided)?.status, 'continue', text);
  }
  for (const waiting of [1, 2]) {
    assert.doesNotMatch(noCardReply(waiting), /nothing/i);
    assert.match(noCardReply(waiting), /still waiting for your approval/);
  }
});

test('with a card still waiting, pointing to it ends the reply and a repeated new-card claim points to it', async t => {
  const outcomes = checkOutcomes(t);
  const replies = [nativeReply('azure', { text: 'The review card is still waiting for your approval.' })];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  const waiting = { waitingCards: async () => 1 };
  const ready = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Is it ready?' }],
    () => assert.fail('No tool expected'),
    undefined,
    false,
    null,
    waiting,
  );
  assert.equal(ready.text, 'The review card is still waiting for your approval.');
  assert.ok(!requests.some(isCompletionRequest));

  const claim = 'I prepared a new review card for the Lime row.';
  replies.push(...[1, 2, 3].map(() => nativeReply('azure', { text: claim })));
  const more = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Add one more row: Lime 10.' }],
    () => assert.fail('No tool expected'),
    undefined,
    false,
    null,
    waiting,
  );
  assert.equal(more.text, noCardReply(1));
  assert.deepEqual(outcomes, ['skipped_no_tools', 'continue', 'continue', 'continue']);
});
