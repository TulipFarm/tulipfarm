import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardClaims,
  claimsActionOutcome,
  cardsForRequest,
  forcedRowTools,
  completionCheckEvidence,
  heldBackMisdescribed,
  heldBackReply,
  heldBackWrites,
  inferWithTools,
  inventedFailure,
  noCardReply,
  reviewCardReceipt,
  rowRequestSkipped,
  tableIdQuestion,
  unbackedCardClaim,
  unbackedImportClaim,
  unbackedWriteClaim,
  uncheckedTableQuestion,
  waitingCardMisdescribed,
  waitingCardStretched,
  waitingRowChanges,
  writtenRows,
} from '../src/inference.ts';
import { completionEvaluation, evaluationMessages } from './completion-evaluation-fixture.mjs';
import { readSkill } from '../src/skills.ts';
import {
  azureStreamReply as stream,
  formats,
  isCompletionRequest,
  nativeName,
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

for (const [model, kind, failure] of [
  ['grok-4.3', 'workflow', 'Use an HTTP request to tulipfarm.ai/api/workflows/draft.'],
  ['Kimi-K2.6', 'agent', 'agents.draft is not offered in this chat.'],
])
  test(`offline discovery replay: ${model} sees ${kind} drafting without inspecting tools_search`, async t => {
    const executed = [];
    const target = kind === 'agent' ? 'agents.draft' : 'workflows.draft';
    const nativeTarget = nativeName(target);
    const input =
      kind === 'agent'
        ? {
            agent: 'new',
            input: {
              expectedSoulRevision: 'a'.repeat(40),
              expectedPolicyVersion: 0,
              expectedActivationIds: [],
              expectedWorkflowRevision: null,
              expectedWorkflowGeneration: null,
              owningTeamId: null,
              definition: { name: 'Records assistant', instructions: 'Read records.', tools: ['rows.list'] },
              setup: {
                policy: { grants: [], personGrants: [] },
                enrollment: [],
                scope: [],
                limits: [],
                taskLimits: { toolCalls: 10, activeMilliseconds: 60000, credits: 10 },
                slackSender: 'user',
                slackChannels: [],
                triggers: [],
              },
            },
          }
        : {
            definition: JSON.stringify({
              version: 1,
              name: 'Daily summary',
              triggers: [{ id: 'daily', kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Kolkata' }],
              steps: [{ id: 'review', kind: 'human', prompt: 'Review records.', timeoutSeconds: 86400 }],
            }),
            activate: false,
          };
    let round = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body)) return Response.json(selectReply('azure', verdict('blocked')));
      const system = body.messages[0].content;
      const index = system.split('# Deferred tools\n')[1]?.split('\n\n')[0] ?? '';
      // This offline stand-in ignores the search function's description, reproducing the reported discovery gap.
      if (!round && !index.includes(nativeTarget)) return Response.json(nativeReply('azure', { text: failure }));
      const offered = offeredTools('azure', body).map(tool => tool.name);
      if (!round++) {
        assert.ok(!offered.includes(nativeTarget), 'the compact index does not preload the draft schema');
        return Response.json(nativeReply('azure', { calls: [use('tools.search', { query: nativeTarget })] }));
      }
      assert.ok(offered.includes(nativeTarget));
      if (round === 2) return Response.json(nativeReply('azure', { calls: [use(target, input)] }));
      return Response.json(nativeReply('azure', { text: 'The draft is ready for your review.' }));
    });
    const result = await inferWithTools(
      { ...nativeRoutes.azure, model },
      [{ role: 'user', text: `Create a ${kind} for a daily records summary.` }],
      async call => {
        executed.push(call.tool);
        assert.equal(call.tool, target, 'no invented HTTP endpoint or helper delegation');
        return { draftId: 'draft', digest: 'd'.repeat(64), status: 'review-required' };
      },
    );
    assert.deepEqual(executed, [target], result.text);
    assert.equal(result.text, 'The draft is ready for your review.');
    assert.equal(round, 3);
  });

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  for (const invoked of [false, true])
    test(`${model} offers agent setup tools when the authoring skill is ${invoked ? 'invoked' : 'read'}`, async t => {
      let step = invoked ? 1 : 0;
      let checks = 0;
      const executed = [];
      const membershipId = '11111111-1111-4111-8111-111111111111';
      const input = {
        expectedSoulRevision: 'a'.repeat(40),
        expectedPolicyVersion: 0,
        expectedActivationIds: [],
        expectedWorkflowRevision: null,
        expectedWorkflowGeneration: null,
        owningTeamId: null,
        definition: {
          name: 'Records assistant',
          instructions: 'Answer questions about records. Do not change data.',
          tools: ['rows.list'],
        },
        setup: {
          policy: { grants: [], personGrants: [{ membershipId, permissions: ['read', 'manage', 'invoke'] }] },
          enrollment: [],
          scope: [],
          limits: [],
          taskLimits: { toolCalls: 10, activeMilliseconds: 60000, credits: 10 },
          slackSender: 'user',
          slackChannels: [],
          triggers: [],
        },
      };
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const body = JSON.parse(init.body);
        if (isCompletionRequest(body)) {
          checks++;
          return Response.json(selectReply('azure', verdict('waiting')));
        }
        assert.equal(body.messages[0].content.includes('/test-space/agents/new'), step > 0);
        const offered = offeredTools('azure', body).map(tool => tool.name);
        if (step) {
          assert.ok(offered.includes('agents_context'));
          assert.ok(offered.includes('agents_draft'));
          assert.ok(offered.includes('agents_delegate'), 'other work can still use delegation');
        }
        return Response.json(
          nativeReply(
            'azure',
            [
              { calls: [use('skills.read', { skillId: 'agent-authoring' })] },
              { calls: [use('agents.context')] },
              { calls: [use('agents.draft', { agent: 'new', input })] },
              { text: 'The Records assistant draft is ready for your review.' },
            ][step++],
          ),
        );
      });
      const result = await inferWithTools(
        { ...nativeRoutes.azure, model },
        [{ role: 'user', text: 'Create a read-only agent that answers questions about records.' }],
        async call => {
          executed.push(call.tool);
          if (call.tool === 'skills.read') return readSkill(call.skillId);
          if (call.tool === 'agents.context') return { membershipId, currentSoulRevision: 'a'.repeat(40) };
          assert.equal(call.tool, 'agents.draft');
          assert.equal(call.agent, 'new');
          assert.deepEqual(call.input.definition, input.definition);
          assert.deepEqual(call.input.setup, input.setup);
          return { draftId: 'draft', digest: 'd'.repeat(64), status: 'review-required' };
        },
        undefined,
        false,
        null,
        { builtinSkills: invoked ? ['agent-authoring'] : [], agentBuilderUrl: '/test-space/agents/new' },
      );
      assert.equal(result.text, 'The Records assistant draft is ready for your review.');
      assert.deepEqual(executed, [...(invoked ? [] : ['skills.read']), 'agents.context', 'agents.draft']);
      assert.equal(step, 4);
      assert.equal(checks, 0, 'a pending draft is a sufficient stopping point');
    });

test('reading another bundled authoring skill loads its own tools, not agent tools', async t => {
  let step = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(selectReply('azure', verdict('waiting')));
    if (!step++)
      return Response.json(nativeReply('azure', { calls: [use('skills.read', { skillId: 'workflow-authoring' })] }));
    const offered = offeredTools('azure', body).map(tool => tool.name);
    for (const name of ['workflows_list', 'workflows_read', 'workflows_draft', 'workflows_providers'])
      assert.ok(offered.includes(name), name);
    assert.ok(!offered.includes('agents_draft'));
    return Response.json(nativeReply('azure', { text: 'Which day should it run?' }));
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create a weekly workflow.' }],
    async call => readSkill(call.skillId),
  );
  assert.equal(result.text, 'Which day should it run?');
});

test('a failed skill read does not load its declared tools', async t => {
  let step = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(selectReply('azure', verdict('blocked')));
    if (!step++)
      return Response.json(nativeReply('azure', { calls: [use('skills.read', { skillId: 'agent-authoring' })] }));
    assert.ok(!offeredTools('azure', body).some(tool => tool.name === 'agents_draft'));
    return Response.json(nativeReply('azure', { text: 'The setup guide could not be read. Nothing was changed.' }));
  });
  const result = await inferWithTools(nativeRoutes.azure, [{ role: 'user', text: 'Create an agent.' }], async () => ({
    error: 'unavailable',
  }));
  assert.equal(result.text, 'The setup guide could not be read. Nothing was changed.');
});

test('blocked authoring has a manual builder link and needs no repeated helper', async t => {
  let step = 0;
  const executed = [];
  const answer = 'You do not have access to create an agent. [Configure manually](/test-space/agents/new).';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(selectReply('azure', verdict('blocked')));
    assert.match(body.messages[0].content, /first failed prerequisite/);
    assert.match(body.messages[0].content, /\[Configure manually\]\(\/test-space\/agents\/new\)/);
    return Response.json(nativeReply('azure', step++ ? { text: answer } : { calls: [use('agents.context')] }));
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create a read-only agent.' }],
    async call => {
      executed.push(call.tool);
      return { error: 'access-denied' };
    },
    undefined,
    false,
    null,
    { builtinSkills: ['agent-authoring'], agentBuilderUrl: '/test-space/agents/new' },
  );
  assert.equal(result.text, answer);
  assert.deepEqual(executed, ['agents.context']);
});

for (const question of [
  'Which records should this agent read?',
  'Which records should it read? Who should see it?',
  'The setup failed. Which records should it read?',
  'Should I continue?',
  'Would you like me to try again?',
  'What else can I help you with?',
  'Would you like me to do anything else?',
])
  test(`completion exhaustion retains the warning for unchecked question ${JSON.stringify(question)}`, async t => {
    let step = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      if (isCompletionRequest(JSON.parse(init.body))) return Response.json(selectReply('azure', verdict('continue')));
      return Response.json(nativeReply('azure', step++ ? { text: question } : { calls: [use('tables.definitions')] }));
    });
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: 'Create a read-only agent.' }],
      async () => ({ tables: [] }),
    );
    assert.match(result.text, /I stopped (?:here|before finishing)/);
  });

test('a necessary question ends without a warning only when the checker confirms the missing input', async t => {
  const question = 'Which table should this agent read?';
  let step = 0,
    checks = 0,
    completionPrompt = '',
    manualBlock = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) {
      checks++;
      completionPrompt = body.messages[0].content;
      return Response.json(
        selectReply('azure', {
          status: 'waiting',
          reason: 'The required table name is missing; the workspace has several readable tables.',
        }),
      );
    }
    manualBlock ||= body.messages[0].content.includes('/test-space/agents/new');
    return Response.json(nativeReply('azure', step++ ? { text: question } : { calls: [use('tables.definitions')] }));
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create a read-only agent.' }],
    async () => ({ tables: [{ label: 'Tickets' }, { label: 'Invoices' }] }),
    undefined,
    false,
    null,
    { agentBuilderUrl: '/test-space/agents/new' },
  );
  assert.equal(result.text, question);
  assert.equal(checks, 1);
  assert.match(completionPrompt, /name the specific missing input/);
  assert.equal(manualBlock, false, 'ordinary chats do not receive the agent setup fallback block');
});

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  for (const sse of [false, true])
    test(`${model} ${sse ? 'SSE' : 'JSON'} refreshes superseded reviews and resumed decisions`, async t => {
      const oldSummary = 'Review the structure of "Vendors". Nothing has been applied.';
      const summary = 'A review card for "Partners" is ready. Review and approve it.';
      const references = [
        { kind: 'table', id: 'vendors' },
        { kind: 'table', id: 'partners' },
      ];
      const replies = [
        nativeReply('azure', {
          calls: [use('tables.propose', { input: '{"plans":[],"label":"Vendors"}' })],
        }),
        nativeReply('azure', {
          calls: [use('tables.propose', { input: '{"plans":[],"label":"Partners"}' })],
        }),
        nativeReply('azure', { text: 'Approve both Vendors and Partners.' }),
      ];
      let proposed = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        const reply = replies.shift();
        assert.ok(reply, 'current card state needs no extra model request');
        return sse ? stream(reply) : Response.json(reply);
      });
      const revised = await inferWithTools(
        { ...nativeRoutes.azure, model },
        [{ role: 'user', text: 'Create Partners instead of Vendors.' }],
        async () => ({
          id: references[proposed++].id,
          status: 'pending',
          reviewSummary: proposed === 1 ? oldSummary : summary,
        }),
        undefined,
        false,
        null,
        {
          reviewCards: async refs => {
            assert.deepEqual(refs, references);
            return [
              { reference: references[0], status: 'superseded' },
              { reference: references[1], status: 'pending', summary },
            ];
          },
        },
      );
      assert.equal(revised.text, summary);
      t.mock.restoreAll();
      for (const status of ['completed', 'rejected', 'expired', 'superseded', 'saved', 'dismissed']) {
        const text =
          status === 'completed' || status === 'saved'
            ? 'The changes were applied and the workflow is active.'
            : `The earlier review is ${status}. Nothing is waiting for approval.`;
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          const body = JSON.parse(init.body);
          if (isCompletionRequest(body)) return Response.json(selectReply('azure', verdict()));
          const current = body.messages.find(message =>
            message.content?.startsWith?.('Current server-verified review states'),
          );
          assert.ok(current, 'the resumed model sees current state, not just its old pending receipt');
          assert.match(current.content, new RegExp(`"status":"${status}"`));
          const reply = nativeReply('azure', { text });
          return sse ? stream(reply) : Response.json(reply);
        });
        const result = await inferWithTools(
          { ...nativeRoutes.azure, model },
          [{ role: 'user', text: 'What is the current state?' }],
          () => assert.fail('Do not repeat a completed proposal'),
          undefined,
          false,
          null,
          {
            priorCalls: 1,
            priorReviewCards: [references[0]],
            reviewCards: async refs => refs.map(reference => ({ reference, status })),
          },
        );
        assert.equal(result.text, text);
        t.mock.restoreAll();
      }
    });

const unchecked =
  "I couldn't check pending invitations just now. Ask again, or a workspace admin can see them on Members.";
const inviteeQuestion = [
  { role: 'user', text: 'Who are the pending invitees in this workspace, and which teams will they join?' },
];
const roster = { memberCount: 0, members: [], teamCount: 0, teams: [], truncated: false };

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  for (const sse of [false, true]) {
    const over = sse ? 'SSE' : 'JSON';
    const run = async (t, replies, found) => {
      const previews = [];
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        if (isCompletionRequest(JSON.parse(init.body))) return Response.json(selectReply('azure', verdict()));
        const reply = replies.length > 1 ? replies.shift() : replies[0];
        return sse ? stream(reply) : Response.json(reply);
      });
      const result = await inferWithTools(
        { ...nativeRoutes.azure, model },
        inviteeQuestion,
        async call => {
          assert.equal(call.tool, 'members.find');
          return { ...roster, ...found };
        },
        undefined,
        false,
        null,
        { preloadedTools: ['members.find'], answerText: update => previews.push(update.text) },
      );
      return { result, previews };
    };

    test(`${model} cannot report invitation state without a lookup over ${over}`, async t => {
      const claim = 'I checked. There are no pending invitees.';
      const { result, previews } = await run(t, [nativeReply('azure', { text: claim })], {});
      assert.equal(result.text, unchecked);
      assert.ok(
        previews.every(text => !text.includes(claim)),
        'unsupported claims never reach streamed text',
      );
    });

    test(`${model} names every listed invitee over ${over}`, async t => {
      const answer = 'ana@example.com is invited to Ops.';
      const { result, previews } = await run(
        t,
        [
          nativeReply('azure', { calls: [use('members.find')] }),
          nativeReply('azure', { text: 'There are no pending invitees.' }),
          nativeReply('azure', { text: answer }),
        ],
        {
          pendingInvitationCount: 1,
          pendingInvitations: [
            { email: 'ana@example.com', status: 'pending', role: 'member', teams: [{ name: 'Ops', role: 'member' }] },
          ],
          invitationsInstruction: 'List each one.',
        },
      );
      assert.equal(result.text, answer);
      assert.ok(previews.every(text => !text.includes('no pending')));
    });

    test(`${model} says hidden invitations are on Members over ${over}`, async t => {
      const answer = "I can't see pending invitations. A workspace admin can check them on Members.";
      const { result } = await run(
        t,
        [
          nativeReply('azure', { calls: [use('members.find')] }),
          nativeReply('azure', { text: 'There are none.' }),
          nativeReply('azure', { text: answer }),
        ],
        { pendingInvitations: 'not-visible', invitationsInstruction: 'Only admins.' },
      );
      assert.equal(result.text, answer);
    });
  }

test('old invitation claims cannot justify a current answer, but do not block later member questions', async t => {
  const history = [
    { role: 'user', text: 'Are there pending workspace invitations?' },
    { role: 'assistant', text: 'I checked. There are none.' },
  ];
  for (const [question, answer, expected] of [
    ['Check pending invitations again.', 'There are none.', unchecked],
    ['Explain how team membership works.', 'Teams group workspace members.', 'Teams group workspace members.'],
    [
      'Write an example reminder for pending invitees.',
      'Please accept your invitation to join the workspace.',
      'Please accept your invitation to join the workspace.',
    ],
    ['What is the capital of France?', 'The capital is Paris.', 'The capital is Paris.'],
    ['Who is invited to the planning meeting?', 'The meeting has two guests.', 'The meeting has two guests.'],
  ]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(nativeReply('azure', { text: answer })));
    const result = await inferWithTools(nativeRoutes.azure, [...history, { role: 'user', text: question }], () =>
      assert.fail('No lookup requested by the model'),
    );
    assert.equal(result.text, expected);
    t.mock.restoreAll();
  }
});

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  for (const scenario of [
    {
      name: 'streamed follow-up',
      question: 'Check again.',
      answer: 'I checked. There are no pending invitees.',
      sse: true,
    },
    { name: 'plain follow-up', question: 'Check again.', answer: 'There are none.' },
    {
      name: 'polite repeated lookup',
      question: 'Could you check one more time?',
      answer: 'I checked. There are no pending invitees.',
      sse: true,
    },
    {
      name: 'confirmation follow-up',
      question: 'Are you sure?',
      answer: 'I checked. There are no pending invitees.',
      sse: true,
    },
    {
      name: 'invitee team follow-up',
      question: 'What about their teams?',
      answer: 'I checked. There are no pending invitees.',
      sse: true,
    },
    { name: 'count follow-up', question: 'How many?', answer: 'There are none.' },
    { name: 'status follow-up', question: 'What is the status?', answer: 'There are none.' },
    { name: 'invitation noun phrase', question: 'Pending invitees?', answer: 'There are none.' },
    {
      name: 'mixed workspace and calendar lookup',
      question: 'Are there any pending workspace invitations? Also show my meetings.',
      answer: 'There are no pending invitations and no meetings.',
    },
    {
      name: 'mixed invitation and calendar clause',
      question: 'List pending workspace invitations and show my meetings.',
      answer: 'There are no pending invitations and no meetings.',
    },
    {
      name: 'draft with negative wording',
      question: 'Write a reminder for pending invitees.',
      answer: 'Please accept your invitation. No reply is needed.',
      draft: true,
    },
    {
      name: 'meeting invitee list',
      question: 'Show my meetings and list their invitees.',
      answer: 'The meeting has two invitees.',
      event: true,
    },
    {
      name: 'meeting attendance question',
      question: 'Who is invited and attending the planning meeting?',
      answer: 'The meeting has two invitees.',
      event: true,
    },
  ])
    test(`${model} respects invitation context for ${scenario.name}`, async t => {
      const previews = [];
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        if (isCompletionRequest(JSON.parse(init.body))) return Response.json(selectReply('azure', verdict()));
        const reply = nativeReply('azure', { text: scenario.answer });
        return scenario.sse ? stream(reply) : Response.json(reply);
      });
      const result = await inferWithTools(
        { ...nativeRoutes.azure, model },
        [
          { role: 'user', text: 'Are there pending workspace invitations?' },
          { role: 'assistant', text: "I can't see invitations. Open Settings > Members." },
          { role: 'user', text: scenario.question },
        ],
        () => assert.fail('No lookup requested by the model'),
        undefined,
        false,
        null,
        {
          answerText: update => previews.push(update.text),
        },
      );
      assert.equal(result.text, scenario.draft || scenario.event ? scenario.answer : unchecked);
      if (!scenario.draft && !scenario.event)
        assert.ok(
          previews.every(text => !text.includes(scenario.answer)),
          'unsupported invitation answers are not streamed',
        );
    });

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

test('repeated plans end with a stated blocker after two corrections and never run tools', async t => {
  const outcomes = checkOutcomes(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(++requests % 2 ? nativeReply('azure', { text: promise }) : selectReply('azure', verdict('continue'))),
  );
  const result = await inferWithTools(
    nativeRoutes.azure,
    messages,
    () => assert.fail(),
    undefined,
    false,
    null,
    resumed,
  );
  // A promise of more work is never sent as the answer.
  assert.equal(
    result.text,
    'I stopped before finishing this request. Check Tool activity for what ran, then ask me to continue.',
  );
  assert.equal(requests, 6);
  assert.deepEqual(outcomes, ['continue', 'continue', 'continue', 'exhausted']);
});

test('a grounded answer the check keeps rejecting is sent with a note that the request may be unfinished', async t => {
  const blocker = 'The import was rejected because the signup values are not valid dates.';
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      ++requests === 1
        ? nativeReply('azure', { calls: [use('tables.definitions')] })
        : requests % 2 === 0
          ? nativeReply('azure', { text: blocker })
          : selectReply('azure', verdict('continue')),
    ),
  );
  const result = await inferWithTools(nativeRoutes.azure, [{ role: 'user', text: 'Import the leads.' }], async () => ({
    tables: [],
  }));
  assert.equal(
    result.text,
    `${blocker}\n\nI stopped here, so this request may not be finished. Check Tool activity for what ran, then ask me to continue.`,
  );
  assert.equal(requests, 7);
});

test('a reply that ran no tool and keeps claiming a write ends without pointing to Tool activity', async t => {
  const outcomes = checkOutcomes(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(nativeReply('azure', { text: 'I added the 3 leads to the Leads table.' }));
  });
  const result = await inferWithTools(nativeRoutes.azure, [{ role: 'user', text: 'Add the leads.' }], () =>
    assert.fail(),
  );
  assert.equal(result.text, "I stopped before finishing this request. Ask me to continue when you're ready.");
  assert.equal(requests.length, 3);
  assert.ok(!requests.some(isCompletionRequest));
  assert.deepEqual(outcomes, ['continue', 'continue', 'continue', 'exhausted']);
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
      results: [
        {
          id: 'p',
          name: 'tables_propose',
          output: '{"id":"x","status":"pending"}',
          cardReceipt: reviewCardReceipt('tables_propose', { id: 'x', status: 'pending' }),
          error: false,
        },
      ],
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
    {
      kind: 'results',
      results: [
        {
          id: 'c',
          name,
          output: `Untrusted tool result for x: ${output}`,
          cardReceipt: reviewCardReceipt(name, JSON.parse(output)),
          error,
        },
      ],
    },
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
  assert.deepEqual(outcomes, ['continue', 'continue', 'continue', 'exhausted']);
});

test('successful work and nested pending data are not review-card receipts', () => {
  for (const [name, output] of [
    ['projects_create', { id: 'project', name: 'Orders' }],
    ['workflows_run', { id: 'run', status: 'completed' }],
    ['workflows_run', { id: 'run', status: 'pending' }],
    ['rows_create', { id: 'row', values: { status: 'pending', draftId: 'data' } }],
    ['tables_propose', { status: 'pending' }],
  ]) {
    const items = [
      {
        kind: 'results',
        results: [{ name, output: JSON.stringify(output), cardReceipt: reviewCardReceipt(name, output), error: false }],
      },
    ];
    assert.equal(unbackedCardClaim('The approval card is ready.', items)?.status, 'continue', name);
  }
  for (const [name, output] of [
    ['workflows_draft', { draftId: 'draft', status: 'review-required' }],
    ['google_propose', { provider: 'google-workspace', data: { id: 'proposal', decision: null, receipt: null } }],
    ['integrations_disconnect', { status: 'review-required' }],
  ]) {
    const items = [
      {
        kind: 'results',
        results: [{ name, output: JSON.stringify(output), cardReceipt: reviewCardReceipt(name, output), error: false }],
      },
    ];
    assert.equal(unbackedCardClaim('The approval card is ready.', items), undefined, name);
  }
});

test('every pending review-card family has an explicit receipt and excludes completed actions', () => {
  const authoring = [
    'agents.draft',
    'skills.draft',
    'workflows.draft',
    'workflows.archive',
    'workflows.restore',
    'agents.archive',
    'agents.restore',
    'skills.archive',
    'skills.restore',
    'projects.draft',
    'files.rename',
    'files.move',
    'files.trash',
    'files.restore',
    'files.share',
    'knowledge.add',
    'knowledge.update',
    'knowledge.remove',
    'memory.edit',
    'rows.create',
    'rows.create.batch',
    'rows.update',
    'rows.delete',
  ];
  const pending = [
    ...authoring.map(tool => [tool, { draftId: 'draft', digest: 'digest', status: 'review-required' }]),
    ['memory.forget', { status: 'forgotten', draftId: 'undo', revision: 2 }],
    ['tables.propose', { id: 'proposal', status: 'pending' }],
    ['github.personal.propose', { batchId: 'batch', decision: null, statuses: ['unattempted'] }],
    ['google.propose', { provider: 'google-workspace', data: { id: 'proposal', decision: null, receipt: null } }],
    ['integrations.connect', { status: 'connect-card', app: 'github' }],
    [
      'integrations.mcp.connect',
      {
        status: 'mcp-connect-card',
        name: 'External tools',
        endpoint: 'https://tools.example.com/mcp',
        authentication: 'none',
      },
    ],
    ['integrations.disconnect', { status: 'review-required', connection: { id: 'connection' } }],
    ['api.request', { provider: 'api-call', kind: 'waiting', callId: 'call' }],
    ['skills.import', { importId: 'import', status: 'ready' }],
    ['skills.import.status', { importId: 'import', status: 'ready' }],
    ['skills.import.select', { importId: 'import', status: 'ready' }],
    ['skills.draft', { importId: 'import', status: 'ready' }],
  ];
  const items = (tool, output) => [
    {
      kind: 'results',
      results: [
        {
          name: tool.replaceAll('.', '_'),
          output: JSON.stringify(output),
          cardReceipt: reviewCardReceipt(tool.replaceAll('.', '_'), output),
          error: false,
        },
      ],
    },
  ];
  for (const [tool, output] of pending)
    assert.equal(unbackedCardClaim('The review card is ready.', items(tool, output)), undefined, tool);
  for (const [tool, output] of [
    ['github.personal.propose', { batchId: 'batch', decision: 'approve', statuses: ['succeeded'] }],
    ['github.personal.propose', { batchId: 'batch', decision: 'reject', statuses: ['rejected'] }],
    ['api.request', { provider: 'api-call', kind: 'sent', callId: 'call', status: 'sent' }],
    ['skills.import', { importId: 'import', status: 'installed' }],
    ['skills.import.status', { importId: 'import', status: 'reviewing' }],
    ['plans.create', { planId: 'plan', version: 1, added: [] }],
    ['memory.forget', { draftId: 'undo', revision: 'revision' }],
    ['memory.forget', { status: 'forgotten', draftId: '' }],
    ['memory.forget', { status: 'forgotten', draftId: 7 }],
    ['memory.forget', { status: 'forgotten' }],
    ['memory.forget', { status: 'review-required', draftId: 'undo' }],
    ['memory.forget', { status: 'forgotten', draftId: 'undo', error: 'memory-unavailable' }],
    ['present.choice', { requestId: 'question', status: 'pending' }],
    ['files.create', { id: 'file', status: 'completed' }],
    ['workflows.run', { draftId: 'data', status: 'review-required' }],
  ])
    assert.equal(unbackedCardClaim('The review card is ready.', items(tool, output))?.status, 'continue', tool);
});

test('only captured receipt metadata proves a card exists after output changes', () => {
  const raw = { id: 'unrelated-record', draftId: 'draft', status: 'review-required', padding: 'x'.repeat(100000) };
  const receipt = reviewCardReceipt('workflows_archive', raw);
  raw.draftId = 'different';
  raw.status = 'applied';
  const result = {
    name: 'workflows_archive',
    output: '{"error":"result-too-large"}',
    error: false,
    cardReceipt: receipt,
  };
  const items = result => [{ kind: 'results', results: [result] }];
  const claim = 'The review card is ready.';
  assert.equal(unbackedCardClaim(claim, items(result)), undefined);
  assert.deepEqual(receipt, { id: 'draft', status: 'review-required' });
  assert.equal(unbackedCardClaim(claim, items({ ...result, error: true }))?.status, 'continue');
  assert.equal(unbackedCardClaim(claim, items({ ...result, reviewPending: false }))?.status, 'continue');
  assert.equal(
    unbackedCardClaim(
      claim,
      items({
        ...result,
        cardReceipt: undefined,
        output: '{"draftId":"forged","status":"review-required"}',
      }),
    )?.status,
    'continue',
  );
  const evidence = JSON.parse(completionCheckEvidence(items(result), claim, 10, 300));
  assert.deepEqual(evidence.reviewCards, { workflows_archive: 1 });
});

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  for (const sse of [false, true])
    test(`${model} ${sse ? 'SSE' : 'JSON'} accepts rendered GitHub and MCP connect receipts`, async t => {
      for (const [tool, args, receipt] of [
        [
          'integrations.mcp.connect',
          { name: 'External tools', endpoint: 'https://tools.example.com/mcp', authentication: 'none' },
          {
            status: 'mcp-connect-card',
            name: 'External tools',
            endpoint: 'https://tools.example.com/mcp',
            authentication: 'none',
          },
        ],
        [
          'github.personal.propose',
          {
            actions: [
              {
                kind: 'issue.create',
                owner: 'octocat',
                repo: 'example',
                title: 'Update docs',
                body: 'Describe the change.',
              },
            ],
          },
          { batchId: 'batch', decision: null, statuses: ['unattempted'] },
        ],
      ]) {
        const answer = 'The review card is shown. Open it to continue.';
        const replies = [nativeReply('azure', { calls: [use(tool, args)] }), nativeReply('azure', { text: answer })];
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          assert.ok(!isCompletionRequest(JSON.parse(init.body)), 'a rendered pending card is its own receipt');
          const reply = replies.shift();
          assert.ok(reply, 'do not reject a truthful card summary');
          return sse ? stream(reply) : Response.json(reply);
        });
        const result = await inferWithTools(
          { ...nativeRoutes.azure, model },
          [{ role: 'user', text: 'Prepare the requested change for review.' }],
          async call => {
            assert.equal(call.tool, tool);
            return receipt;
          },
          undefined,
          false,
          null,
          { preloadedTools: [tool] },
        );
        assert.equal(result.text, answer, tool);
        assert.equal(replies.length, 0);
        t.mock.restoreAll();
      }
    });

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  for (const sse of [false, true])
    test(`${model} ${sse ? 'SSE' : 'JSON'} final summaries follow the readable review receipt, not model contradictions`, async t => {
      const summary =
        'A review card for "Orders" is ready in this chat. It imports "orders.csv". Review and approve it to apply the changes. Nothing in this card has been applied.';
      for (const text of [
        'No new card was created. I will not add those rows.',
        'An earlier card for Customers is waiting. Approve or dismiss it first.',
        'The import review for Customers from customers.csv is ready.',
      ]) {
        const replies = [
          nativeReply('azure', { calls: [use('tables.propose', { input: '{"plans":[]}' })] }),
          nativeReply('azure', { text }),
        ];
        const previews = [];
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          assert.equal(JSON.parse(init.body).model, model);
          const reply = replies.shift();
          assert.ok(reply, 'a persisted review needs no extra model evaluation');
          return sse ? stream(reply) : Response.json(reply);
        });
        const result = await inferWithTools(
          { ...nativeRoutes.azure, model },
          [{ role: 'user', text: 'Import orders.csv into Orders.' }],
          async call => {
            assert.equal(call.tool, 'tables.propose');
            return { id: 'review', status: 'pending', reviewSummary: summary };
          },
          undefined,
          false,
          null,
          {
            answerText: update => previews.push(update.text),
            reviewCards: async refs => refs.map(reference => ({ reference, status: 'pending', summary })),
          },
        );
        assert.equal(result.text, summary);
        assert.equal(previews.at(-1), summary);
        assert.equal(replies.length, 0);
        t.mock.restoreAll();
      }
      const priorSummary =
        'A review card for 9 rows in "Orders" is ready in this chat. No rows from this card have been written.';
      t.mock.method(globalThis, 'fetch', async () => {
        const reply = nativeReply('azure', { text: 'No card was created. Ask me to create it again.' });
        return sse ? stream(reply) : Response.json(reply);
      });
      const resumed = await inferWithTools(
        { ...nativeRoutes.azure, model },
        [{ role: 'user', text: 'Add the 9 rows to Orders.' }],
        () => assert.fail('Do not repeat a completed proposal'),
        undefined,
        false,
        null,
        {
          priorCalls: 1,
          priorReviewCards: [{ kind: 'row', id: 'review' }],
          reviewCards: async refs => refs.map(reference => ({ reference, status: 'pending', summary: priorSummary })),
        },
      );
      assert.equal(resumed.text, priorSummary);
      t.mock.restoreAll();
      t.mock.method(globalThis, 'fetch', async () => {
        const reply = nativeReply('azure', {
          calls: [use('tables.propose', { input: '{"plans":[]}' })],
        });
        return sse ? stream(reply) : Response.json(reply);
      });
      const exhausted = await inferWithTools(
        { ...nativeRoutes.azure, model },
        [{ role: 'user', text: 'Add the 9 rows to Orders.' }],
        () => assert.fail('The exhausted turn must not repeat the proposal'),
        undefined,
        false,
        null,
        {
          priorCalls: 1000,
          priorReviewCards: [{ kind: 'row', id: 'review' }],
          reviewCards: async refs => refs.map(reference => ({ reference, status: 'pending', summary: priorSummary })),
        },
      );
      assert.equal(exhausted.text, priorSummary);
      t.mock.restoreAll();
      const failed = [
        nativeReply('azure', { calls: [use('tables.propose', { input: '{"plans":[]}' })] }),
        ...Array.from({ length: 3 }, () =>
          nativeReply('azure', { text: 'The import review card for Orders is ready below.' }),
        ),
      ];
      t.mock.method(globalThis, 'fetch', async () => {
        const reply = failed.shift();
        assert.ok(reply, 'unbacked claims stop after bounded corrections');
        return sse ? stream(reply) : Response.json(reply);
      });
      const rejected = await inferWithTools(
        { ...nativeRoutes.azure, model },
        [{ role: 'user', text: 'Import orders.csv into Orders.' }],
        async () => ({ error: 'import-values-invalid' }),
      );
      assert.equal(rejected.text, noCardReply());
      assert.equal(failed.length, 0);
    });

test('an unbacked import review is sent back until a proposal exists, and the new card ends the reply unchecked', async t => {
  const outcomes = checkOutcomes(t);
  const replies = [
    nativeReply('azure', { text: 'Here is the import review. Do you confirm this import?' }),
    nativeReply('azure', { calls: [use('tables.propose', { input: '{"plans":[]}' })] }),
    nativeReply('azure', { text: 'The import review card is ready below.' }),
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
    [false, false, false],
  );
  assert.match(JSON.stringify(requests[1].messages), /no tables\.propose call in this reply returned a pending review/);
  assert.deepEqual(outcomes, ['continue', 'done']);
  assert.equal(replies.length, 0);
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
  assert.match(JSON.stringify(requests[1].messages), /nothing in this turn wrote any data/);
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

test('continue results after real tool work end the reply instead of failing after two corrections', async t => {
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
  const result = await inferWithTools(nativeRoutes.azure, [{ role: 'user', text: 'Set it up.' }], async () => ({
    tables: [],
  }));
  assert.equal(
    result.text,
    'I stopped before finishing this request. Check Tool activity for what ran, then ask me to continue.',
  );
  assert.equal(requests, 7);
  assert.deepEqual(outcomes, ['continue', 'continue', 'continue', 'exhausted']);
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
  assert.deepEqual(outcomes, ['skipped_no_tools', 'continue', 'continue', 'continue', 'exhausted']);
});

test('a row request for another table is made, not refused behind the waiting card', async t => {
  const claim = 'A review card is still waiting for your approval. Please approve it first, then I can add Rose 3.';
  const done = 'I added Rose 3 to Other Ledger.';
  const replies = [
    nativeReply('azure', { text: claim }),
    nativeReply('azure', {
      calls: [
        use('rows.create', {
          tableId: '00000000-0000-4000-8000-0000000000aa',
          expectedAppliedRevision: 'a'.repeat(40),
          values: fruit('Rose', '3').values,
        }),
      ],
    }),
    nativeReply('azure', { text: done }),
  ];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(selectReply('azure', verdict()));
    requests.push(body);
    assert.ok(replies.length, 'bounded provider requests');
    return Response.json(replies.shift());
  });
  const calls = [];
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Add one row to the Other Ledger table, Item and Amount: Rose 3.' }],
    async call => {
      calls.push(call.tool);
      return { record: { id: 'r', values: {} } };
    },
    undefined,
    false,
    null,
    {
      preloadedTools: ['rows.create'],
      waitingCards: async () => 1,
      waitingRowCards: async () => [{ table: 'Fruit ledger', input: nineRows }],
    },
  );
  assert.equal(result.text, done);
  assert.deepEqual(calls, ['rows.create']);
  assert.match(JSON.stringify(requests[1].messages), /another table[\s\S]*Fruit ledger/);
});

test('a reply never asks the person for a table ID, and asks about a table only after looking tables up', () => {
  for (const text of [
    'Could you share the table ID for Pantry Stock?',
    'I could not find that table. Please provide the table ID.',
    'What is the ID of the table you want?',
  ])
    assert.equal(tableIdQuestion(text)?.status, 'continue', text);
  for (const text of ['I added 3 rows to the Pantry Stock table.', 'Which ID should the new row use?'])
    assert.equal(tableIdQuestion(text), undefined, text);
  const lookedUp = [
    { kind: 'results', results: [{ id: 'c', name: 'tables_definitions', output: '{}', error: false }] },
  ];
  const question = 'Do you want me to use Pantry Stock as the table name?';
  assert.equal(uncheckedTableQuestion(question, [])?.status, 'continue');
  assert.equal(uncheckedTableQuestion(question, lookedUp), undefined);
  assert.equal(uncheckedTableQuestion('I added 3 rows to the Pantry Stock table.', []), undefined);
});

test('asking which table, after a lookup, ends the reply once corrections run out', async t => {
  const outcomes = checkOutcomes(t);
  const question = 'Two tables are called Pantry Stock, one in Ops and one in Sales. Which table do you mean?';
  const replies = [
    nativeReply('azure', { calls: [use('tables.definitions')] }),
    ...Array.from({ length: 3 }, () => [
      nativeReply('azure', { text: question }),
      selectReply('azure', verdict('continue')),
    ]).flat(),
  ];
  t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()));
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Add 3 rows to Pantry Stock.' }],
    async () => ({ tables: [] }),
  );
  assert.equal(result.text, question);
  assert.equal(replies.length, 0);
  assert.deepEqual(outcomes, ['continue', 'continue', 'continue', 'exhausted']);
});

const itemField = '00000000-0000-4000-8000-000000000001';
const amountField = '00000000-0000-4000-8000-000000000002';
const fruit = (item, amount) => ({
  values: { [itemField]: { kind: 'text', value: item }, [amountField]: { kind: 'numeric', value: amount } },
});
const nineRows = {
  tool: 'rows.create.batch',
  rows: ['Apple', 'Banana', 'Cherry', 'Date', 'Fig', 'Grape', 'Kiwi', 'Mango', 'Pear'].map((item, index) =>
    fruit(item, String(index + 1)),
  ),
};
const heldBack = (notAdded = ['Lime 10']) => [
  {
    kind: 'results',
    results: [
      {
        id: 'r',
        name: 'rows_create',
        output: `Untrusted tool result for r: ${JSON.stringify({
          error: 'approval-pending',
          table: 'Fruit ledger',
          waitingCard: {
            rows: 9,
            sample: ['Apple 1', 'Banana 2', 'Cherry 3'],
            summary: 'add 9 rows (Apple 1, Banana 2, Cherry 3, …) to',
          },
          notAdded,
        })}`,
        error: false,
      },
    ],
  },
];

test('a row write held back behind a waiting card is explained with what that card holds and the row asked for', () => {
  const [held] = heldBackWrites(heldBack());
  assert.equal(
    heldBackReply(held),
    'Nothing new was added. A card to add 9 rows (Apple 1, Banana 2, Cherry 3, …) to "Fruit ledger" is still waiting for your approval in this chat. Approve or dismiss it, then ask again for Lime 10.',
  );
  const [unnamed] = heldBackWrites(heldBack([]));
  assert.match(heldBackReply(unnamed, 'Add one more row: Lime 10.'), /then ask again for Lime 10\.$/);
  assert.match(heldBackReply(unnamed, 'Add Lime 10 and Kiwi 4: Lime 10 and Kiwi 4'), /for Lime 10, Kiwi 4\.$/);
  assert.match(heldBackReply(unnamed, 'Add one more row'), /then ask again for this change\.$/);
});

test('a reply that merges a held-back row into the waiting card or blames a failure is rewritten', () => {
  for (const text of [
    'I added Lime 10 to the approval card, so the card now has 10 rows.',
    'Once you approve the card, Lime 10 will be added along with the others.',
    'The card holds 10 rows in total.',
    'The earlier 9 rows failed, so nothing was saved.',
    'You do not have permission to add rows to this table.',
  ])
    assert.equal(heldBackMisdescribed(text, heldBack())?.status, 'continue', text);
  for (const text of [
    'Nothing new was added. A card to add 9 rows (Apple 1, Banana 2, Cherry 3, …) to "Fruit ledger" is still waiting. Approve or dismiss it, then ask again for Lime 10.',
    'Lime 10 is not on any card. The waiting card holds the 9 earlier rows; approve or dismiss it and ask again.',
  ])
    assert.equal(heldBackMisdescribed(text, heldBack()), undefined, text);
  assert.equal(heldBackMisdescribed('The card holds 10 rows in total.', []), undefined);
});

test('a waiting card from an earlier turn must be named for what it holds, and only holds that', () => {
  const cards = waitingRowChanges([{ table: 'Fruit ledger', input: nineRows }]);
  assert.equal(cards[0].summary, 'add 9 rows (Apple 1, Banana 2, Cherry 3, …) to');
  assert.equal(waitingCardMisdescribed('Please approve the card first.', cards)?.status, 'continue');
  assert.equal(waitingCardMisdescribed('The card for 10 rows is waiting.', cards)?.status, 'continue');
  assert.equal(
    waitingCardMisdescribed('The card to add 9 rows is still waiting; approve or dismiss it.', cards),
    undefined,
  );
  assert.equal(waitingCardMisdescribed('The card with Apple and Banana is still waiting.', cards), undefined);
  assert.equal(waitingCardMisdescribed('Please approve the card first.', []), undefined);
});

test('only a row request for the table of a waiting card is held to that card', () => {
  const cards = waitingRowChanges([{ table: 'Fruit ledger', input: nineRows }]);
  assert.equal(cardsForRequest(cards, 'Add one more row: Lime 10.').length, 1);
  assert.equal(cardsForRequest(cards, 'Add one row to the fruit ledger table: Lime 10.').length, 1);
  assert.equal(cardsForRequest(cards, 'Add one row to the Other Ledger table, Item and Amount: Rose 3.').length, 0);
  assert.equal(cardsForRequest(cards, 'What is waiting in this chat?').length, 1);
});

test('a reply that says a waiting card already covers a new row request is sent back to make the change', () => {
  const earlier = 'Add these nine rows to Fruit ledger: Apple 1, Banana 2, Cherry 3';
  const request = 'Add one more row: Lime 10.';
  for (const text of [
    'Lime 10 is already on the approval card with the others.',
    'The card covers all 10 rows, so approve it and they will all be added.',
  ])
    assert.equal(waitingCardStretched(text, [], request, earlier)?.status, 'continue', text);
  for (const text of [
    'The card holds only the 9 earlier rows. Approve or dismiss it, then ask again for Lime 10.',
    'Should I add Lime 10 once you approve the card?',
  ])
    assert.equal(waitingCardStretched(text, [], request, earlier), undefined, text);
  assert.equal(waitingCardStretched('Lime 10 is already on the card.', heldBack(), request, earlier), undefined);
});

test('a row request answered without trying the row change is sent back while a card waits', () => {
  const cards = waitingRowChanges([{ table: 'Fruit ledger', input: nineRows }]);
  const tableCard = [
    {
      kind: 'results',
      results: [
        {
          id: 'p',
          name: 'tables_propose',
          output: '{"id":"p","status":"pending"}',
          cardReceipt: reviewCardReceipt('tables_propose', { id: 'p', status: 'pending' }),
          error: false,
        },
      ],
    },
  ];
  assert.equal(rowRequestSkipped([], 'Add one more row: Lime 10.', cards)?.status, 'continue');
  assert.equal(rowRequestSkipped(tableCard, 'Add one more row: Lime 10.', cards)?.status, 'continue');
  assert.equal(rowRequestSkipped(tableCard, 'Create a new table with a row for Lime 10.', cards), undefined);
  assert.equal(rowRequestSkipped(heldBack(), 'Add one more row: Lime 10.', cards), undefined);
  assert.equal(rowRequestSkipped([], 'Add one more row: Lime 10.', []), undefined);
  assert.equal(rowRequestSkipped([], 'What is waiting?', cards), undefined);
  const other = 'Add one row to the Other Ledger table, Item and Amount: Rose 3.';
  const skipped = rowRequestSkipped([], other, cardsForRequest(cards, other), cards);
  assert.equal(skipped?.status, 'continue');
  assert.match(skipped.reason, /another table[\s\S]*"Fruit ledger" only/);
  assert.equal(rowRequestSkipped(heldBack(), other, [], cards), undefined);
});

test('a reply that blames access or a failure while a card waits and nothing failed is rewritten', () => {
  const text = 'I could not add it because you do not have permission. Contact your admin.';
  assert.equal(inventedFailure(text, [], 1)?.status, 'continue');
  assert.equal(inventedFailure(text, [], 0), undefined);
  const denied = [
    { kind: 'results', results: [{ id: 'd', name: 'rows_create', output: '{"error":"access-denied"}', error: true }] },
  ];
  assert.equal(inventedFailure(text, denied, 1), undefined);
  assert.equal(inventedFailure('The card to add 9 rows is still waiting.', [], 1), undefined);
});

test('the fixed reply for an invented card names the waiting card when one is known', () => {
  assert.equal(
    noCardReply(1, { table: 'Fruit ledger', summary: 'add 9 rows (Apple 1, Banana 2, Cherry 3, …) to' }),
    'No new approval card is waiting from this reply. A card to add 9 rows (Apple 1, Banana 2, Cherry 3, …) to "Fruit ledger" is still waiting for your approval in this chat: approve or dismiss it there first.',
  );
});

const otherLedger = '00000000-0000-4000-8000-0000000000aa';
const ledgerStatus = { id: otherLedger, name: 'Other Ledger', savedRevision: 'a'.repeat(40) };
const roseRequest = [{ role: 'user', text: 'Add one row to the Other Ledger table, Item and Amount: Rose 3.' }];
const refusal = 'A review card is still waiting for your approval. Please approve it first, then I can add Rose 3.';
const roseWrite = (tableId = otherLedger) =>
  use('rows.create.batch', { tableId, expectedAppliedRevision: 'a'.repeat(40), rows: [fruit('Rose', '3')] });
const forcedTool = body => body.tool_choice?.function?.name ?? body.tool_choice?.name;
const waitingFruit = {
  preloadedTools: ['schema.inspect', 'rows.create.batch'],
  waitingCards: async () => 1,
  waitingRowCards: async () => [{ table: 'Fruit ledger', input: nineRows }],
};
/** Answers each provider from its own reply list and the completion check as done, recording the requests. */
function providers(t, replies) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const provider = String(url).includes('anthropic') ? 'anthropic' : 'azure';
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(selectReply(provider, verdict()));
    requests.push({ provider, body });
    const reply = replies[provider].shift();
    assert.ok(reply, `bounded ${provider} requests`);
    return Response.json(reply);
  });
  return requests;
}
const rowTable = async call =>
  call.tool === 'schema.inspect' ? ledgerStatus : { records: [{ id: 'r', values: {} }], total: null, nextCursor: null };

test('a row request answered with no tool call is sent back with the table tools it must call', async t => {
  const done = 'I added Rose 3 to Other Ledger.';
  const requests = providers(t, {
    azure: [
      nativeReply('azure', { text: refusal }),
      nativeReply('azure', { calls: [use('schema.inspect', { tableId: otherLedger })] }),
      nativeReply('azure', { calls: [roseWrite()] }),
      nativeReply('azure', { text: done }),
    ],
  });
  const calls = [];
  const result = await inferWithTools(
    nativeRoutes.azure,
    roseRequest,
    async call => (calls.push(call.tool), rowTable(call)),
    undefined,
    false,
    null,
    waitingFruit,
  );
  assert.equal(result.text, done);
  assert.deepEqual(calls, ['schema.inspect', 'rows.create.batch']);
  assert.deepEqual(
    requests.map(request => forcedTool(request.body)),
    [undefined, nativeName('schema.inspect'), nativeName('rows.create.batch'), undefined],
  );
});

test('a wrong table ID on a forced row write is corrected once with the write forced again', async t => {
  const requests = providers(t, {
    azure: [
      nativeReply('azure', { text: refusal }),
      nativeReply('azure', { calls: [use('schema.inspect', { tableId: otherLedger })] }),
      nativeReply('azure', { calls: [roseWrite('00000000-0000-4000-8000-0000000000bb')] }),
      nativeReply('azure', { calls: [roseWrite()] }),
      nativeReply('azure', { text: 'I added Rose 3 to Other Ledger.' }),
    ],
  });
  await inferWithTools(
    nativeRoutes.azure,
    roseRequest,
    async call =>
      call.tool === 'rows.create.batch' && call.tableId !== otherLedger
        ? { error: 'table-not-found', tables: [{ id: otherLedger, name: 'Other Ledger' }] }
        : rowTable(call),
    undefined,
    false,
    null,
    waitingFruit,
  );
  assert.deepEqual(
    requests.map(request => forcedTool(request.body)),
    [
      undefined,
      nativeName('schema.inspect'),
      nativeName('rows.create.batch'),
      nativeName('rows.create.batch'),
      undefined,
    ],
  );
});

test('a row request still unmade under forced table tools is answered by the fallback model', async t => {
  const done = 'I added Rose 3 to Other Ledger.';
  const requests = providers(t, {
    azure: [refusal, refusal, refusal].map(text => nativeReply('azure', { text })),
    anthropic: [nativeReply('anthropic', { calls: [roseWrite()] }), nativeReply('anthropic', { text: done })],
  });
  const calls = [];
  const result = await inferWithTools(
    nativeRoutes.azure,
    roseRequest,
    async call => (calls.push(call.tool), rowTable(call)),
    undefined,
    false,
    null,
    { ...waitingFruit, fallback: { route: nativeRoutes.anthropic, label: 'claude-fallback' } },
  );
  assert.deepEqual(result, { text: done, fallback: 'claude-fallback' });
  assert.deepEqual(calls, ['rows.create.batch']);
  assert.deepEqual(
    requests.slice(0, 3).map(request => [request.provider, forcedTool(request.body)]),
    [
      ['azure', undefined],
      ['azure', nativeName('schema.inspect')],
      ['anthropic', undefined],
    ],
  );
});

test('when the fallback also makes no row change, the reply gives up with the stop reply', async t => {
  providers(t, {
    azure: [refusal, refusal, refusal].map(text => nativeReply('azure', { text })),
    anthropic: Array.from({ length: 8 }, () => nativeReply('anthropic', { text: refusal })),
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    roseRequest,
    () => assert.fail('No tool expected'),
    undefined,
    false,
    null,
    { ...waitingFruit, fallback: { route: nativeRoutes.anthropic, label: 'claude-fallback' } },
  );
  assert.equal(result.fallback, 'claude-fallback');
  assert.match(result.text, /^I stopped before finishing this request\./);
});

test('the fixed reply about a waiting card first states the rows this reply did write', async t => {
  const claim = 'I prepared a new review card for the Rose row.';
  providers(t, {
    azure: [
      nativeReply('azure', { calls: [use('schema.inspect', { tableId: otherLedger })] }),
      nativeReply('azure', { calls: [roseWrite()] }),
      ...[1, 2, 3, 4].map(() => nativeReply('azure', { text: claim })),
    ],
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    roseRequest,
    async call =>
      call.tool === 'schema.inspect'
        ? ledgerStatus
        : { records: [{ id: 'r', values: fruit('Rose', '3').values }], total: null, nextCursor: null },
    undefined,
    false,
    null,
    waitingFruit,
  );
  assert.match(result.text, /^Rose 3 was added to "Other Ledger"\. No new approval card is waiting/);
});

test('written rows are named per table, counted when many, and changes are counted', () => {
  const step = (call, output) => [
    { kind: 'model', text: '', calls: [{ id: 'c', name: call.name, input: call.input }] },
    {
      kind: 'results',
      results: [
        { id: 'c', name: call.name, output: `Untrusted tool result for c: ${JSON.stringify(output)}`, error: false },
      ],
    },
  ];
  const inspect = step(use('schema.inspect', { tableId: otherLedger }), ledgerStatus);
  const record = (item, amount) => ({ id: 'r', values: fruit(item, amount).values });
  assert.equal(
    writtenRows([...inspect, ...step(roseWrite(), record('Rose', '3'))]),
    'Rose 3 was added to "Other Ledger".',
  );
  const batch = use('rows.create.batch', { tableId: otherLedger, rows: [] });
  const records = ['Ash', 'Elm', 'Oak', 'Yew'].map((item, index) => record(item, String(index)));
  assert.equal(
    writtenRows([...step(batch, { records: records.slice(0, 2), total: null, nextCursor: null })]),
    'Ash 0, Elm 1 were added to the table.',
  );
  assert.equal(
    writtenRows([...inspect, ...step(batch, { records, total: null, nextCursor: null })]),
    '4 rows were added to "Other Ledger".',
  );
  assert.equal(
    writtenRows([...inspect, ...step(use('rows.update', { tableId: otherLedger }), record('Rose', '4'))]),
    '1 row was changed in "Other Ledger".',
  );
  assert.equal(writtenRows([...inspect, ...step(roseWrite(), { error: 'approval-pending' })]), '');
});

test('the forced table tools follow the change a row request names first, among the offered tools', () => {
  const offered = ['schema.inspect', 'rows.list', 'rows.create.batch', 'rows.update.batch'].map(nativeName);
  const forced = request => forcedRowTools(request, offered).map(name => name.replaceAll('_', '.'));
  assert.deepEqual(forced('Add one row to the Ledger table: Rose 3.'), ['schema.inspect', 'rows.create.batch']);
  assert.deepEqual(forced('Change the Rose row in Ledger to 4, then add Lime 10.'), ['schema.inspect', 'rows.list']);
  assert.deepEqual(forced('Create a new table called Ledger.'), []);
});
