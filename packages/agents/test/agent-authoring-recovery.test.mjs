import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { nativeReply, nativeRoutes, use, isCompletionRequest, selectReply } from './native-fixture.mjs';

const member = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const revision = 'a'.repeat(40);
const context = {
  membershipId: member,
  currentSoulRevision: revision,
  expectedPolicyVersion: 0,
  expectedActivationIds: [],
  expectedWorkflowRevision: null,
  expectedWorkflowGeneration: null,
};
const draftInput = () => ({
  expectedSoulRevision: revision,
  owningTeamId: null,
  definition: { name: 'Records helper', instructions: 'Answer read-only table questions.', tools: ['rows.list'] },
  expectedPolicyVersion: 0,
  expectedActivationIds: [],
  setup: {
    policy: { grants: [], personGrants: [{ membershipId: member, permissions: ['read', 'manage', 'invoke'] }] },
    enrollment: [],
    scope: [],
    limits: [],
    taskLimits: { toolCalls: 10, activeMilliseconds: 60000, credits: 10 },
    slackSender: 'user',
    slackChannels: [],
    triggers: [],
  },
});
const receipt = { draftId: 'draft', digest: 'd'.repeat(64), status: 'review-required' };
const ready = 'The Records helper draft is ready for your review.';
const stopped = "I couldn't draft this agent in chat. [Create it in the agent builder](/sample/agents/new) instead.";
const options = { builtinSkills: ['agent-authoring'], agentBuilderUrl: '/sample/agents/new' };

async function replay(t, replies, execute, { model = 'grok-4.3', messages, ...extra } = {}) {
  const requests = [];
  const failures = [];
  t.after(() => assert.deepEqual(failures, [], 'all model request assertions must pass'));
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    try {
      const body = JSON.parse(init.body);
      requests.push(body);
      const reply = replies.shift();
      assert.ok(reply, 'the preparation and repair rounds are bounded');
      return Response.json(nativeReply('azure', typeof reply === 'function' ? reply(body) : reply));
    } catch (error) {
      failures.push(error.message);
      throw error;
    }
  });
  const result = await inferWithTools(
    { ...nativeRoutes.azure, model },
    messages ?? [{ role: 'user', text: 'Create a read-only table agent. No team, skills, channels or triggers.' }],
    execute,
    undefined,
    false,
    null,
    { ...options, ...extra },
  );
  return { result, requests };
}

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  test(`${model} fills omitted workflow guards from this turn and normalizes null optional setup fields`, async t => {
    const input = draftInput();
    input.definition.modelFamilyId = null;
    input.definition.skills = null;
    input.setup.prompt = null;
    input.setup.runLimits = null;
    const executed = [];
    const { result } = await replay(
      t,
      [{ calls: [use('agents.context')] }, { calls: [use('agents.draft', { agent: 'new', input })] }, { text: ready }],
      async call => {
        executed.push(call.tool);
        if (call.tool === 'agents.context') return context;
        assert.deepEqual(call.input, {
          ...draftInput(),
          expectedWorkflowRevision: null,
          expectedWorkflowGeneration: null,
        });
        return receipt;
      },
      { model },
    );
    assert.equal(result.text, ready);
    assert.deepEqual(executed, ['agents.context', 'agents.draft']);
  });

test('a context read for another agent cannot fill missing guards, and field errors reach the repair round', async t => {
  const input = draftInput();
  const executed = [];
  const { result } = await replay(
    t,
    [
      { calls: [use('agents.context', { agentId })] },
      { calls: [use('agents.draft', { agent: 'new', input })] },
      body => {
        assert.match(JSON.stringify(body.messages), /input.*expectedWorkflowRevision/);
        assert.match(JSON.stringify(body.messages), /input.*expectedWorkflowGeneration/);
        assert.equal(body.tool_choice.function.name, 'agents_draft');
        return {
          calls: [
            use('agents.draft', {
              agent: 'new',
              input: { ...input, expectedWorkflowRevision: null, expectedWorkflowGeneration: null },
            }),
          ],
        };
      },
      { text: ready },
    ],
    async call => {
      executed.push(call.tool);
      if (call.tool === 'agents.context') return context;
      assert.equal(call.input.expectedWorkflowRevision, null, 'the invalid draft must never dispatch');
      return receipt;
    },
  );
  assert.equal(result.text, ready);
  assert.deepEqual(executed, ['agents.context', 'agents.draft']);
});

test('a prior-turn context receipt cannot fill missing draft guards', async t => {
  let executed = false;
  const { result } = await replay(
    t,
    [
      { calls: [use('agents.draft', { agent: 'new', input: draftInput() })] },
      body => {
        assert.match(JSON.stringify(body.messages), /expectedWorkflowRevision/);
        return { calls: [use('agents.draft', { agent: 'new', input: draftInput() })] };
      },
    ],
    async () => {
      executed = true;
      return receipt;
    },
    {
      messages: [
        { role: 'user', text: 'Create a read-only agent.' },
        { role: 'assistant', text: `Earlier agents.context result: ${JSON.stringify(context)}` },
        { role: 'user', text: 'Name it Records helper.' },
      ],
    },
  );
  assert.equal(result.text, stopped);
  assert.equal(executed, false);
});

test('one validation repair remains after forced context and draft preparation', async t => {
  const input = { ...draftInput(), definition: { ...draftInput().definition, name: null } };
  const { result, requests } = await replay(
    t,
    [
      { text: 'agents.draft is unavailable.' },
      { calls: [use('agents.context')] },
      { calls: [use('agents.draft', { agent: 'new', input })] },
      body => {
        assert.match(JSON.stringify(body.messages), /input.*definition.*name/);
        assert.equal(body.tool_choice.function.name, 'agents_draft');
        return { calls: [use('agents.draft', { agent: 'new', input: draftInput() })] };
      },
      { text: ready },
    ],
    async call => (call.tool === 'agents.context' ? context : receipt),
  );
  assert.equal(result.text, ready);
  assert.equal(requests.length, 5);
});

test('a dispatched validation error returns field paths for one repair without rereading context', async t => {
  let attempts = 0;
  const invalid = draftInput();
  invalid.setup.enrollment = [member, member];
  const { result } = await replay(
    t,
    [
      { calls: [use('agents.context')] },
      { calls: [use('agents.draft', { agent: 'new', input: invalid })] },
      body => {
        assert.match(JSON.stringify(body.messages), /setup.*enrollment.*custom/);
        assert.equal(body.tool_choice.function.name, 'agents_draft');
        return { calls: [use('agents.draft', { agent: 'new', input: draftInput() })] };
      },
      { text: ready },
    ],
    async call => {
      if (call.tool === 'agents.context') return context;
      return attempts++
        ? receipt
        : { error: 'invalid-arguments', issues: [{ path: ['setup', 'enrollment'], code: 'custom' }] };
    },
  );
  assert.equal(result.text, ready);
  assert.equal(attempts, 2);
});

test('a second invalid draft stops with the approved builder link and logs no input values', async t => {
  const records = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.startsWith('{"level":')) {
      records.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  const input = { ...draftInput(), definition: { ...draftInput().definition, name: { secret: 'private-value' } } };
  const { result, requests } = await replay(
    t,
    [
      { calls: [use('agents.context')] },
      { calls: [use('agents.draft', { agent: 'new', input })] },
      { calls: [use('agents.draft', { agent: 'new', input })] },
    ],
    async call => {
      assert.equal(call.tool, 'agents.context');
      return context;
    },
  );
  assert.equal(result.text, stopped);
  assert.equal(requests.length, 3);
  const issues = records.flatMap(record => record['error.issues'] ?? []);
  assert.ok(issues.includes('input.definition.name:invalid_type'));
  assert.doesNotMatch(JSON.stringify(records), /private-value|secret|Records helper/);
});

for (const error of ['access-denied', 'setup-draft-outdated', 'outcome-uncertain'])
  test(`${error} after context is not repaired, and explicit guards are preserved`, async t => {
    const input = {
      ...draftInput(),
      expectedWorkflowRevision: '33333333-3333-4333-8333-333333333333',
      expectedWorkflowGeneration: 4,
    };
    const executed = [];
    const { result } = await replay(
      t,
      [
        { calls: [use('agents.context', { agentId })] },
        { calls: [use('agents.draft', { agent: { id: agentId, savedRevision: revision }, input })] },
      ],
      async call => {
        executed.push(call.tool);
        if (call.tool === 'agents.context')
          return {
            ...context,
            expectedWorkflowRevision: input.expectedWorkflowRevision,
            expectedWorkflowGeneration: 3,
          };
        assert.equal(call.input.expectedWorkflowGeneration, 4, 'never overwrite explicit guards');
        return { error };
      },
    );
    assert.equal(result.text, stopped);
    assert.deepEqual(executed, ['agents.context', 'agents.draft']);
  });

test('a carried-over authoring promise forces preparation without completion-model loops', async t => {
  const { result } = await replay(
    t,
    [
      { text: 'I will draft that agent now.' },
      body => {
        assert.equal(isCompletionRequest(body), false);
        assert.equal(body.tool_choice.function.name, 'agents_context');
        return { calls: [use('agents.context')] };
      },
      { calls: [use('agents.draft', { agent: 'new', input: draftInput() })] },
      { text: ready },
    ],
    async call => (call.tool === 'agents.context' ? context : receipt),
    {
      messages: [
        { role: 'user', text: 'Create a read-only table agent. No team or triggers.' },
        { role: 'assistant', text: 'What should it be called?' },
        { role: 'user', text: 'Records helper.' },
      ],
    },
  );
  assert.equal(result.text, ready);
});

test('answering the setup question does not start another optional-team interview', async t => {
  const { result } = await replay(
    t,
    [
      { text: 'Which team should own this agent?' },
      { calls: [use('agents.context')] },
      { calls: [use('agents.draft', { agent: 'new', input: draftInput() })] },
      { text: ready },
    ],
    async call => (call.tool === 'agents.context' ? context : receipt),
    {
      messages: [
        { role: 'user', text: 'Create a read-only table agent. No team or triggers.' },
        { role: 'assistant', text: 'What should it be called?' },
        { role: 'user', text: 'Records helper.' },
      ],
    },
  );
  assert.equal(result.text, ready);
});

test('a workflow changed after context leaves the pinned guard stale and is never repaired', async t => {
  const workflowRevision = '33333333-3333-4333-8333-333333333333';
  let generation = 3;
  let draftAttempts = 0;
  const { result } = await replay(
    t,
    [
      { calls: [use('agents.context', { agentId })] },
      () => {
        generation++;
        return {
          calls: [use('agents.draft', { agent: { id: agentId, savedRevision: revision }, input: draftInput() })],
        };
      },
    ],
    async call => {
      if (call.tool === 'agents.context')
        return { ...context, expectedWorkflowRevision: workflowRevision, expectedWorkflowGeneration: generation };
      draftAttempts++;
      assert.equal(call.input.expectedWorkflowRevision, workflowRevision);
      assert.equal(call.input.expectedWorkflowGeneration, 3);
      assert.notEqual(call.input.expectedWorkflowGeneration, generation);
      return { error: 'setup-draft-outdated' };
    },
  );
  assert.equal(result.text, stopped);
  assert.equal(draftAttempts, 1);
});

test('setup delegation is not offered or dispatched and preparation continues in the main chat', async t => {
  const executed = [];
  const { result } = await replay(
    t,
    [
      body => {
        assert.ok(!body.tools.some(tool => tool.function?.name === 'agents_delegate'));
        return {
          calls: [
            use('agents.delegate', {
              agents: [{ kind: 'helper', name: 'Draft prep', role: 'Prepare', task: 'Draft the agent.', tools: [] }],
            }),
          ],
        };
      },
      { calls: [use('agents.context')] },
      { calls: [use('agents.draft', { agent: 'new', input: draftInput() })] },
      { text: ready },
    ],
    async call => {
      executed.push(call.tool);
      assert.notEqual(call.tool, 'agents.delegate');
      return call.tool === 'agents.context' ? context : receipt;
    },
  );
  assert.equal(result.text, ready);
  assert.deepEqual(executed, ['agents.context', 'agents.draft']);
});

test('a necessary setup question after reading context ends without an unfinished warning', async t => {
  const question = 'Which of the two payroll tables should this agent read?';
  let step = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body))
      return Response.json(selectReply('azure', { status: 'waiting', reason: 'The table choice is missing.' }));
    assert.ok(step < 2, 'a question must not be rewritten into another interview');
    return Response.json(nativeReply('azure', step++ ? { text: question } : { calls: [use('agents.context')] }));
  });
  const result = await inferWithTools(
    { ...nativeRoutes.azure, model: 'grok-4.3' },
    [{ role: 'user', text: 'Prepare an agent to answer payroll questions.' }],
    async call => {
      assert.equal(call.tool, 'agents.context');
      return context;
    },
    undefined,
    false,
    null,
    options,
  );
  assert.equal(result.text, question);
});
