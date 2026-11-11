import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import {
  azureStreamReply,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  selectReply,
  use,
} from './native-fixture.mjs';

const tableId = '00000000-0000-4000-8000-000000000001';
const fieldId = '00000000-0000-4000-8000-000000000002';
const revision = 'a'.repeat(40);
const request = 'Add 9 rows to Orders, named Order 1 through Order 9, for review before writing anything.';
const summary = 'A review card for 9 rows in "Orders" is ready in this chat. No rows from this card have been written.';
const schema = { id: tableId, name: 'Orders', savedRevision: revision };
const batch = () =>
  use('rows.create.batch', {
    tableId,
    expectedAppliedRevision: revision,
    rows: Array.from({ length: 9 }, (_, i) => ({
      values: { [fieldId]: { kind: 'text', value: `Order ${i + 1}` } },
    })),
  });
const receipt = { draftId: 'review', status: 'review-required' };
const context = {
  preloadedTools: ['schema.inspect', 'rows.create.batch'],
  reviewCards: async refs => refs.map(reference => ({ reference, status: 'pending', summary })),
};
const stopped = "I couldn't prepare the review card, so no rows were changed. Ask me to try again.";
const requestsForReview = [
  request,
  'Create 9 rows in the Orders table for review before writing anything.',
  'Add 9 new rows to the Orders table for review before writing anything.',
  'Prepare 9 rows in Orders for approval before writing anything.',
  'Draft 9 rows in Orders.',
];

function provider(t, responses, { stream = false, completion = 'completed', rowReviewRequested = true } = {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body))
      return Response.json(
        selectReply('azure', {
          status: completion,
          reason: 'Fixture verdict.',
          ...(rowReviewRequested !== null && { rowReviewRequested }),
        }),
      );
    requests.push(body);
    const response = responses.shift();
    assert.ok(response, 'recovery must be bounded');
    const reply = nativeReply('azure', response);
    return stream ? azureStreamReply(reply) : Response.json(reply);
  });
  return requests;
}

for (const model of ['grok-4.3', 'Kimi-K2.6', 'DeepSeek-V4-Pro']) {
  for (const [run, text] of [
    'The 9 rows are ready for you to review.',
    'Here you go.',
    'Done.',
    'All set.',
    'Take a look below.',
  ].entries())
    test(`${model} row review run ${run + 1} needs a receipt regardless of reply wording`, async t => {
      const responses = [
        { text },
        { calls: [use('schema.inspect', { tableId })] },
        { calls: [batch()] },
        { text: 'All set.' },
      ];
      const requests = provider(t, responses, { stream: run % 2 === 0 });
      const calls = [];
      const previews = [];
      const result = await inferWithTools(
        { ...nativeRoutes.azure, model },
        [{ role: 'user', text: requestsForReview[run] }],
        async call => {
          calls.push(call.tool);
          return call.tool === 'schema.inspect' ? schema : receipt;
        },
        undefined,
        false,
        null,
        { ...context, answerText: update => previews.push(update.text) },
      );
      assert.equal(result.text, summary);
      assert.deepEqual(calls, ['schema.inspect', 'rows.create.batch']);
      assert.deepEqual(
        requests.map(body => body.tool_choice?.function?.name),
        [undefined, 'schema_inspect', 'rows_create_batch', undefined],
      );
      assert.ok(!previews.includes(text), 'an unchecked claim must not stream as a ready card');
      assert.equal(responses.length, 0);
    });

  test(`${model} an explicit card retry reads the schema without asking permission`, async t => {
    const responses = [
      { text: 'May I read the table schema first?' },
      { calls: [use('schema.inspect', { tableId })] },
      { calls: [batch()] },
      { text: 'All set.' },
    ];
    const requests = provider(t, responses);
    const calls = [];
    const result = await inferWithTools(
      { ...nativeRoutes.azure, model },
      [
        { role: 'user', text: request },
        { role: 'assistant', text: 'The 9 rows are ready for you to review.' },
        { role: 'user', text: 'Please create the review card.' },
      ],
      async call => {
        calls.push(call.tool);
        return call.tool === 'schema.inspect' ? schema : receipt;
      },
      undefined,
      false,
      null,
      context,
    );
    assert.equal(result.text, summary);
    assert.equal(requests[1].tool_choice?.function?.name, 'schema_inspect');
    assert.deepEqual(calls, ['schema.inspect', 'rows.create.batch']);
  });
}

test('a failed row review cannot be accepted by a permissive completion check', async t => {
  provider(t, [
    { calls: [use('schema.inspect', { tableId })] },
    { calls: [batch()] },
    { text: 'The 9 rows are ready for you to review.' },
    { text: 'Here you go.' },
    { text: 'Done.' },
  ]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: request }],
    async call => (call.tool === 'schema.inspect' ? schema : { error: 'record-invalid' }),
    undefined,
    false,
    null,
    context,
  );
  assert.equal(result.text, stopped);
});

test('a successful schema read is reused when the reply asks permission instead of preparing rows', async t => {
  const requests = provider(t, [
    { calls: [use('schema.inspect', { tableId })] },
    { text: 'May I read the table schema first?' },
    { calls: [batch()] },
    { text: 'All set.' },
  ]);
  const calls = [];
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: request }],
    async call => {
      calls.push(call.tool);
      return call.tool === 'schema.inspect' ? schema : receipt;
    },
    undefined,
    false,
    null,
    context,
  );
  assert.equal(result.text, summary);
  assert.equal(requests[2].tool_choice?.function?.name, 'rows_create_batch');
  assert.deepEqual(calls, ['schema.inspect', 'rows.create.batch']);
});

test('a row receipt that is no longer readable cannot substantiate a ready card', async t => {
  provider(t, [{ calls: [batch()] }, { text: 'All set.' }, { text: 'All set.' }, { text: 'All set.' }]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: request }],
    async () => receipt,
    undefined,
    false,
    null,
    {
      ...context,
      reviewCards: async refs => refs.map(reference => ({ reference, status: 'unavailable' })),
    },
  );
  assert.equal(result.text, stopped);
});

test('a row tool receipt without a saved-card read cannot substantiate a ready card', async t => {
  provider(t, [{ calls: [batch()] }, { text: 'All set.' }, { text: 'All set.' }, { text: 'All set.' }]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: request }],
    async () => receipt,
    undefined,
    false,
    null,
    { preloadedTools: context.preloadedTools },
  );
  assert.equal(result.text, stopped);
});

test('a direct write is reported truthfully instead of claiming no rows changed', async t => {
  provider(t, [
    { calls: [use('schema.inspect', { tableId })] },
    { calls: [batch()] },
    { text: 'All set.' },
    { text: 'All set.' },
    { text: 'All set.' },
  ]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: request }],
    async call =>
      call.tool === 'schema.inspect'
        ? schema
        : {
            records: [{ id: 'written-row', values: { [fieldId]: { kind: 'text', value: 'Order 1' } } }],
          },
    undefined,
    false,
    null,
    context,
  );
  assert.match(result.text, /^Order 1 was added to "Orders"\. No approval card was made/);
  assert.ok(!result.text.includes('no rows were changed'));
});

test('a structure-only card cannot replace row review but a records proposal can', async t => {
  for (const kind of ['schema', 'records']) {
    provider(t, [
      { calls: [use('tables.propose', { input: JSON.stringify({ plans: [{ kind }] }) })] },
      { text: 'All set.' },
      { text: 'All set.' },
      { text: 'All set.' },
    ]);
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: request }],
      async () => ({ id: 'review', status: 'pending' }),
      undefined,
      false,
      null,
      context,
    );
    assert.equal(result.text, kind === 'records' ? summary : stopped);
    t.mock.restoreAll();
  }
});

test('an unrelated saved card is not a receipt for the requested row review', async t => {
  provider(t, [
    {
      calls: [
        use('integrations.mcp.connect', {
          name: 'External tools',
          endpoint: 'https://tools.example.com/mcp',
          authentication: 'none',
        }),
      ],
    },
    { text: 'The 9 rows are ready for you to review.' },
    { text: 'Here you go.' },
    { text: 'Done.' },
  ]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: request }],
    async () => ({
      status: 'mcp-connect-card',
      name: 'External tools',
      endpoint: 'https://tools.example.com/mcp',
      authentication: 'none',
    }),
    undefined,
    false,
    null,
    { ...context, preloadedTools: [...context.preloadedTools, 'integrations.mcp.connect'] },
  );
  assert.equal(result.text, stopped);
});

test('repeated schema-permission questions end truthfully, not as permission requests', async t => {
  const requests = provider(
    t,
    Array.from({ length: 3 }, () => ({ text: 'May I read the table schema first?' })),
  );
  const result = await inferWithTools(
    nativeRoutes.azure,
    [
      { role: 'user', text: request },
      { role: 'assistant', text: 'The 9 rows are ready for you to review.' },
      { role: 'user', text: 'Please create the review card.' },
    ],
    () => assert.fail('The model ignored the required tools'),
    undefined,
    false,
    null,
    context,
  );
  assert.equal(result.text, stopped);
  assert.equal(requests.length, 3);
});

test('row review recovery leaves read-only turns and evidence-backed table questions alone', async t => {
  provider(t, [{ text: 'All set.' }, { text: 'All set.' }, { text: 'All set.' }]);
  const missing = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: request }],
    () => assert.fail(),
    undefined,
    false,
    null,
    context,
  );
  assert.equal(missing.text, stopped);
  t.mock.restoreAll();
  for (const messages of [
    [{ role: 'user', text: 'Show the rows in Orders for review.' }],
    [
      { role: 'user', text: request },
      { role: 'user', text: 'What is a review card?' },
    ],
    [
      { role: 'user', text: request },
      { role: 'user', text: 'Create a skill draft for writing reports.' },
      { role: 'user', text: 'Please create the review card.' },
    ],
  ]) {
    const requests = provider(t, [{ text: 'Which details would you like?' }], { rowReviewRequested: false });
    const result = await inferWithTools(
      nativeRoutes.azure,
      messages,
      () => assert.fail('No row mutation belongs to this turn'),
      undefined,
      false,
      null,
      context,
    );
    assert.equal(result.text, 'Which details would you like?');
    assert.equal(requests.length, 1);
    t.mock.restoreAll();
  }
  const question = 'Which Orders table should I use: Sales or Support?';
  provider(t, [{ calls: [use('tables.definitions', { name: 'Orders' })] }, { text: question }], {
    completion: 'waiting',
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: request }],
    async call => {
      assert.equal(call.tool, 'tables.definitions');
      return {
        tables: [
          { id: tableId, label: 'Orders', team: 'Sales' },
          { id: fieldId, label: 'Orders', team: 'Support' },
        ],
      };
    },
    undefined,
    false,
    null,
    context,
  );
  assert.equal(result.text, question);
});

test('the checker recognizes review intent outside imperative row wording', async t => {
  for (const text of [
    'The nine Orders entries need my approval before any are saved.',
    'Let me check the new Orders entries before you save them.',
    'I want a look at those Orders entries before they go in.',
  ]) {
    provider(t, [
      { text: 'All set.' },
      { calls: [use('schema.inspect', { tableId })] },
      { calls: [batch()] },
      { text: 'Done.' },
    ]);
    const calls = [];
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text }],
      async call => {
        calls.push(call.tool);
        return call.tool === 'schema.inspect' ? schema : receipt;
      },
      undefined,
      false,
      null,
      context,
    );
    assert.equal(result.text, summary);
    assert.deepEqual(calls, ['schema.inspect', 'rows.create.batch']);
    t.mock.restoreAll();
  }
});

test('a broad review prefilter does not override false or missing checker intent', async t => {
  for (const rowReviewRequested of [false, null]) {
    provider(t, [{ text: 'The rows can be reviewed without changing them.' }], { rowReviewRequested });
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: 'Review the rows in Orders, but do not change them.' }],
      () => assert.fail('Read-only requests must not force writes'),
      undefined,
      false,
      null,
      context,
    );
    assert.equal(result.text, 'The rows can be reviewed without changing them.');
    t.mock.restoreAll();
  }
});

test('an unavailable checker keeps an informational answer instead of forcing row review', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    return isCompletionRequest(body)
      ? new Response('unavailable', { status: 400 })
      : Response.json(nativeReply('azure', { text: 'Review means checking the rows before a change.' }));
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'What does review before writing mean?' }],
    () => assert.fail('An unavailable checker must not establish intent'),
    undefined,
    false,
    null,
    context,
  );
  assert.equal(result.text, 'Review means checking the rows before a change.');
});
