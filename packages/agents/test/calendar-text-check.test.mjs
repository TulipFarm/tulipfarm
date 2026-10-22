import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { bindCalendarText, calendarTextRecovery } from '../src/calendar-text-check.ts';
import { nativeReply, selectReply, useCall } from './native-fixture.mjs';

const route = {
  provider: 'azure',
  endpoint: 'https://synthetic.openai.azure.com/',
  model: 'DeepSeek-V4-Flash',
  auth: { kind: 'api-key', value: 'synthetic' },
};
const unspecified = { mode: 'unspecified' };
const literal = (text, message = 0) => ({ mode: 'literal', source: { message, text } });
const checked = (summary, description) => ({ summary, description });
const proposal = (summary, description, kind = 'calendar.events.create') => ({
  kind: 'tool',
  call: {
    tool: 'google.propose',
    operation: {
      kind,
      calendarId: 'primary',
      ...(kind.endsWith('update') ? { eventId: 'qa' } : {}),
      event: {
        summary,
        ...(description === undefined ? {} : { description }),
        start: { date: '2026-10-05' },
        end: { date: '2026-10-06' },
      },
    },
  },
});
const answer = { kind: 'answer', text: 'Ready for review.' };
const completion = { status: 'completed', reason: 'The proposal is ready for review.' };
// Chat steps offer native tools with automatic choice; the independent text check forces select_action.
const response = (decision, request) =>
  Response.json(
    request.tool_choice !== 'auto'
      ? selectReply('azure', decision)
      : nativeReply(
          'azure',
          decision.kind === 'tool'
            ? { calls: [useCall(decision.call, 'Proposing the event')] }
            : { text: decision.text },
        ),
  );

async function run(t, messages, decisions, options = {}) {
  decisions = decisions.flatMap(decision => (decision === answer ? [decision, completion] : [decision]));
  const requests = [],
    calls = [],
    steps = [],
    settled = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    assert.ok(decisions.length, 'bounded provider requests');
    return response(decisions.shift(), request);
  });
  const result = await inferWithTools(
    route,
    messages,
    async call => {
      calls.push(call);
      return { id: 'review' };
    },
    async input => {
      steps.push(input.step);
      if (options.denyStep === input.step) throw new Error('credit-limit');
      return async usage => settled.push({ step: input.step, usage });
    },
    false,
    null,
    options.priorCalls === undefined ? undefined : { catalog: async () => undefined, priorCalls: options.priorCalls },
  );
  return { result, requests, calls, steps, settled };
}

for (const kind of ['calendar.events.create', 'calendar.events.update'])
  test(`${kind} rejects changed punctuation, title and whitespace, then dispatches only corrected text`, async t => {
    const title = "  We're ready 🌷!  ",
      description = 'Café e\u0301.\nSecond line.  ';
    const messages = [{ role: 'user', text: `Title: "${title}"\nDescription: "${description}"` }];
    const out = await run(t, messages, [
      proposal(title.trim(), description.trim().normalize('NFC'), kind),
      checked(literal(title), literal(description)),
      proposal(title, description, kind),
      answer,
    ]);
    assert.deepEqual(out.result, { text: 'Ready for review.' });
    assert.deepEqual(out.calls, [proposal(title, description, kind).call]);
    assert.deepEqual(out.steps, [0, 1, 2, 3, 4]);
    assert.deepEqual(
      out.settled.map(({ step, usage }) => [step, usage.kind, usage.input, usage.output]),
      [
        [0, 'known', 10, 7],
        [1, 'known', 10, 7],
        [2, 'known', 10, 7],
        [3, 'known', 10, 7],
        [4, 'known', 10, 7],
      ],
    );
    const independent = JSON.parse(out.requests[1].messages[1].content);
    assert.deepEqual(
      independent.messages,
      messages.map((message, index) => ({ index, ...message })),
    );
    assert.equal('fields' in independent, false);
    assert.equal('event' in independent.target, false);
    assert.equal(out.requests[1].tool_choice.function.name, 'select_action');
    assert.deepEqual(
      out.requests.map(request => request.tool_choice === 'auto'),
      [true, false, true, true, false],
    );
    assert.equal(out.requests[2].messages.at(-1).role, 'tool');
    assert.equal(out.requests[2].messages.at(-1).tool_call_id, 'call_0');
    assert.match(out.requests[2].messages.at(-1).content, /rejected before execution or review/);
  });

test('a replacement binds to the newer user message; rewriting is field-specific', async t => {
  const messages = [
    { role: 'user', text: 'Description "Old."' },
    { role: 'assistant', text: 'Use New without punctuation.' },
    { role: 'user', text: 'Replace description with "New.". Rewrite the title "team sync" in title case.' },
  ];
  const binding = checked(
    { mode: 'rewrite', source: { message: 2, text: 'Rewrite the title "team sync" in title case.' } },
    literal('New.', 2),
  );
  const out = await run(t, messages, [proposal('Team Sync', 'New'), binding, proposal('Team Sync', 'New.'), answer]);
  assert.deepEqual(out.calls, [proposal('Team Sync', 'New.').call]);
  assert.deepEqual(out.result, { text: 'Ready for review.' });
});

test('unspecified description stays omitted on update; supplied description cannot be omitted', async t => {
  let out = await run(
    t,
    [{ role: 'user', text: 'Move my event to tomorrow.' }],
    [proposal('Existing', undefined, 'calendar.events.update'), checked(unspecified, unspecified), answer],
  );
  assert.deepEqual(out.result, { text: 'Ready for review.' });
  assert.equal(Object.hasOwn(out.calls[0].operation.event, 'description'), false);
  out = await run(
    t,
    [{ role: 'user', text: 'Use description "Initial QA event."' }],
    [
      proposal('QA', undefined),
      checked(unspecified, literal('Initial QA event.')),
      proposal('QA', 'Initial QA event.'),
      answer,
    ],
  );
  assert.equal(out.calls[0].operation.event.description, 'Initial QA event.');
});

for (const invalid of [
  checked(unspecified, literal('invented')),
  checked(unspecified, literal('Initial QA event.', 1)),
  checked(unspecified, { mode: 'rewrite', source: { message: 0, text: 'Please rewrite' } }),
  checked(unspecified, { mode: 'inconclusive' }),
  { kind: 'answer', text: 'Looks fine.' },
])
  test(`invalid or inconclusive independent check stops with recovery: ${JSON.stringify(invalid)}`, async t => {
    const out = await run(
      t,
      [
        { role: 'user', text: 'Description "Initial QA event."' },
        { role: 'assistant', text: 'Initial QA event.' },
      ],
      [proposal('QA', 'Initial QA event'), invalid],
    );
    assert.deepEqual(out.result, { text: calendarTextRecovery });
    assert.deepEqual(out.calls, []);
    assert.deepEqual(out.steps, [0, 1]);
  });

test('source reference rejects normalization and ambiguous duplicate substrings', () => {
  for (const [original, selected] of [
    ['Café e\u0301.', 'Café é.'],
    ['Same. Same.', 'Same.'],
  ]) {
    assert.equal(
      bindCalendarText({ decision: checked(unspecified, literal(selected)) }, [{ role: 'user', text: original }]),
      null,
    );
  }
  assert.deepEqual(
    bindCalendarText({ decision: checked(unspecified, literal('Initial QA event.')) }, [
      { role: 'user', text: 'Description "Initial QA event."' },
    ]),
    { summary: unspecified, description: { mode: 'literal', text: 'Initial QA event.' } },
  );
});

test('repeated mismatches share the two-correction budget and do not recheck the same target', async t => {
  const out = await run(
    t,
    [{ role: 'user', text: 'Description "Initial QA event."' }],
    [
      proposal('QA', 'Initial QA event'),
      checked(unspecified, literal('Initial QA event.')),
      proposal('QA', 'Initial QA event'),
      proposal('QA', 'Initial QA event'),
    ],
  );
  assert.deepEqual(out.result, { text: calendarTextRecovery });
  assert.deepEqual(out.calls, []);
  assert.equal(out.requests.length, 4);
});

test('check reserves credits before dispatch and existing tool limit prevents extra checks', async t => {
  await assert.rejects(run(t, [{ role: 'user', text: 'Propose an event.' }], [proposal('QA')], { denyStep: 1 }), {
    message: 'credit-limit',
  });
  const out = await run(t, [{ role: 'user', text: 'Propose an event.' }], [proposal('QA')], { priorCalls: 1000 });
  assert.deepEqual(out.result, {
    text: 'The tool limit was reached. Review the completed actions before asking me to continue.',
  });
  assert.deepEqual(out.steps, [0]);
});

test('a different Calendar target gets its own interpretation', async t => {
  const second = proposal('QA', 'Two.');
  second.call.operation.calendarId = 'other';
  const out = await run(
    t,
    [{ role: 'user', text: 'Primary description "One."; other description "Two."' }],
    [
      proposal('QA', 'One.'),
      checked(unspecified, literal('One.')),
      second,
      checked(unspecified, literal('Two.')),
      answer,
    ],
  );
  assert.deepEqual(out.result, { text: 'Ready for review.' });
  assert.deepEqual(
    out.calls.map(call => call.operation.event.description),
    ['One.', 'Two.'],
  );
  assert.equal(out.requests.length, 6);
});
