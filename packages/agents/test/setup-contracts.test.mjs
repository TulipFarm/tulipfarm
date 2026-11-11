import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentDefinitionSchema } from '../src/contracts.ts';
import {
  agentSetupConsentSchema,
  agentSetupSchema,
  publishAgentSetupSchema,
  saveAgentSetupDraftSchema,
} from '../src/setup-contracts.ts';
import { agentLinkedDefinition, previewAgentTriggerCadence } from '../src/agent-trigger-workflows.ts';
import { agentSetupDigest } from '../src/setup.ts';
import { authoringProposalSchema, draftDecisionSchema } from '../src/draft-contracts.ts';
import { frameworkCallSchema, discoverTools } from '../src/tools.ts';
import { agentContextSchema } from '../src/saved-contracts.ts';
import { listSkills } from '../src/skills.ts';
import { nativeChatTools } from '../src/native-tools.ts';
import { conversationToolNameAllowed } from '@tulipfarm/conversations/runtime';

const member = randomUUID();
const limits = { toolCalls: 10, activeMilliseconds: 60000, credits: 10 };
const setup = () => ({
  definition: { name: 'Helper', instructions: 'Help with approved tasks.', tools: [] },
  owningTeamId: null,
  policy: { grants: [], personGrants: [{ membershipId: member, permissions: ['read', 'manage', 'invoke'] }] },
  enrollment: [],
  scope: [],
  limits: [],
  taskLimits: limits,
  slackSender: 'user',
  slackChannels: [],
  triggers: [],
});
const input = () => ({
  requestId: randomUUID(),
  expectedVersion: 0,
  expectedSoulRevision: 'a'.repeat(40),
  expectedSavedRevision: null,
  expectedPolicyVersion: 0,
  expectedActivationIds: [],
  expectedWorkflowRevision: null,
  expectedWorkflowGeneration: null,
  setup: setup(),
});

test('setup surrounds the unchanged strict definition and enforces existing limits', () => {
  assert.equal(agentSetupSchema.parse(setup()).definition.name, 'Helper');
  assert.equal(agentDefinitionSchema.safeParse({ ...setup().definition, setup: {} }).success, false);
  for (const definition of [
    { name: 'x'.repeat(121) },
    { instructions: 'x'.repeat(32001) },
    { tools: Array(21).fill('rows.list') },
    { skills: Array(17).fill({ id: 'agent-authoring', revision: 'latest' }) },
  ])
    assert.equal(
      agentSetupSchema.safeParse({ ...setup(), definition: { ...setup().definition, ...definition } }).success,
      false,
    );
  assert.equal(agentSetupSchema.safeParse({ ...setup(), enrollment: [member, member] }).success, false);
  const trigger = { id: randomUUID(), trigger: { kind: 'interval', minutes: 60 } };
  const prompt = 'Check pending requests.';
  assert.equal(agentSetupSchema.safeParse({ ...setup(), prompt, triggers: [trigger] }).success, true);
  assert.equal(agentSetupSchema.safeParse({ ...setup(), prompt, triggers: [trigger, trigger] }).success, false);
  assert.equal(
    agentSetupSchema.safeParse({ ...setup(), triggers: [trigger] }).success,
    false,
    'triggers need a prompt',
  );
  assert.equal(
    agentSetupSchema.safeParse({ ...setup(), prompt: 'x'.repeat(8001), triggers: [trigger] }).success,
    false,
  );
  const many = count => Array.from({ length: count }, () => ({ ...trigger, id: randomUUID() }));
  assert.equal(agentSetupSchema.safeParse({ ...setup(), prompt, triggers: many(20) }).success, true);
  assert.equal(agentSetupSchema.safeParse({ ...setup(), prompt, triggers: many(21) }).success, false);
});

test('setups and consent stored before triggers moved to Workflows read as triggers', () => {
  const id = randomUUID();
  const trigger = { kind: 'cron', expression: '0 9 * * 1', timezone: 'Asia/Kolkata' };
  const { triggers: _triggers, ...legacy } = setup();
  const parsed = agentSetupSchema.parse({
    ...legacy,
    schedules: [
      {
        id,
        trigger,
        action: { kind: 'task', text: 'Prepare the weekly update.', limits },
        sponsorMembershipId: member,
      },
    ],
  });
  assert.deepEqual(
    { prompt: parsed.prompt, runLimits: parsed.runLimits, triggers: parsed.triggers },
    { prompt: 'Prepare the weekly update.', runLimits: limits, triggers: [{ id, trigger }] },
  );
  assert.equal('schedules' in parsed, false);
  assert.deepEqual(agentSetupConsentSchema.parse({ sponsorScheduleIds: [id], replaceChannels: [] }), {
    sponsor: false,
    sponsorTriggerIds: [id],
    replaceChannels: [],
  });
});

test('activation consent no longer needs a sponsor flag', () => {
  assert.deepEqual(agentSetupConsentSchema.parse({ sponsor: false, replaceChannels: [] }), {
    sponsor: false,
    replaceChannels: [],
  });
  assert.equal(agentSetupConsentSchema.safeParse({ replaceChannels: [] }).success, true);
});

test('setups with a prompt on each trigger read as one prompt, without manual entries', () => {
  const [hourly, manual] = [randomUUID(), randomUUID()];
  const parsed = agentSetupSchema.parse({
    ...setup(),
    triggers: [
      { id: manual, trigger: { kind: 'manual' }, prompt: 'Summarize the inbox.', limits },
      { id: hourly, trigger: { kind: 'interval', minutes: 60 }, prompt: 'Summarize the inbox.', limits },
    ],
  });
  assert.deepEqual(
    { prompt: parsed.prompt, runLimits: parsed.runLimits, triggers: parsed.triggers },
    {
      prompt: 'Summarize the inbox.',
      runLimits: limits,
      triggers: [{ id: hourly, trigger: { kind: 'interval', minutes: 60 } }],
    },
  );
});

test('an agent setup becomes one Workflow whose triggers all run the setup prompt', () => {
  const [hourly, inbound] = [randomUUID(), randomUUID()];
  const definition = agentLinkedDefinition(
    { id: member, name: 'Helper' },
    {
      prompt: 'Check in.',
      runLimits: limits,
      triggers: [
        { id: hourly, trigger: { kind: 'interval', minutes: 60 } },
        { id: inbound, label: 'Inbound', trigger: { kind: 'webhook' } },
      ],
    },
  );
  assert.deepEqual(
    definition.triggers.map(trigger => [trigger.id, trigger.kind, trigger.label]),
    [
      [`t_${hourly.replaceAll('-', '')}`, 'interval', undefined],
      [`t_${inbound.replaceAll('-', '')}`, 'webhook', 'Inbound'],
    ],
  );
  assert.equal(definition.name, 'Helper');
  assert.deepEqual(
    definition.steps.map(step => [step.kind, step.prompt, step.limits]),
    [['agent', { kind: 'literal', value: 'Check in.' }, limits]],
  );
  assert.throws(() => agentLinkedDefinition({ id: member, name: 'Helper' }, { triggers: [] }));
});

test('the review digest freezes setup, versions and identity, not transport request identity', () => {
  const agentId = randomUUID(),
    value = saveAgentSetupDraftSchema.parse(input());
  const digest = agentSetupDigest(agentId, value);
  assert.equal(agentSetupDigest(agentId, { ...value, requestId: randomUUID() }), digest);
  for (const changed of [
    { ...value, expectedVersion: 1 },
    { ...value, expectedPolicyVersion: 1 },
    { ...value, expectedActivationIds: [randomUUID()] },
    { ...value, expectedWorkflowRevision: randomUUID(), expectedWorkflowGeneration: 1 },
    { ...value, setup: { ...value.setup, enrollment: [randomUUID()] } },
    {
      ...value,
      setup: {
        ...value.setup,
        slackChannels: [{ channel: 'C123', expectedVersion: 2, replaceAgentId: randomUUID(), detach: false }],
      },
    },
  ])
    assert.notEqual(agentSetupDigest(agentId, changed), digest);
  assert.notEqual(agentSetupDigest(randomUUID(), value), digest);
});

test('chat supports full setup without accepting model-authored consent', () => {
  const { definition, owningTeamId, ...details } = setup();
  const value = {
    expectedSoulRevision: 'a'.repeat(40),
    definition,
    owningTeamId,
    setup: details,
    expectedPolicyVersion: 0,
    expectedActivationIds: [],
  };
  const call = { tool: 'agents.draft', agent: 'new', input: value };
  assert.equal(frameworkCallSchema.safeParse(call).success, true);
  assert.equal(
    frameworkCallSchema.safeParse({
      ...call,
      input: { ...value, consent: { sponsorTriggerIds: [], replaceChannels: [] } },
    }).success,
    false,
  );
  assert.equal(
    authoringProposalSchema.safeParse({
      kind: 'agent',
      targetId: randomUUID(),
      input: { ...value, expectedSavedRevision: null },
    }).success,
    true,
  );
  assert.equal(frameworkCallSchema.safeParse({ tool: 'agents.context', channels: ['C123'] }).success, true);
  assert.equal(discoverTools({ kind: 'chat' }).find(tool => tool.name === 'agents.draft').inputSchema.type, 'object');
  assert.equal(
    publishAgentSetupSchema.safeParse({
      requestId: randomUUID(),
      version: 1,
      digest: 'b'.repeat(64),
      decision: 'activate',
    }).success,
    false,
  );
  assert.equal(
    draftDecisionSchema.safeParse({
      commandId: randomUUID(),
      digest: 'b'.repeat(64),
      decision: 'activate',
      consent: { sponsorTriggerIds: [], replaceChannels: [] },
    }).success,
    true,
  );
});

test('authoring context exposes only current bundled metadata', () => {
  const metadata = listSkills().skills;
  assert.ok(metadata.length > 0);
  assert.ok(metadata.every(skill => skill.revision === 'latest' && !('instructions' in skill)));
  assert.deepEqual(
    agentContextSchema.parse({ currentSoulRevision: 'a'.repeat(40), teams: [], builtinSkills: metadata }).builtinSkills,
    metadata,
  );
  assert.deepEqual(agentContextSchema.parse({ currentSoulRevision: 'a'.repeat(40), teams: [] }).builtinSkills, []);
});

test('create agent discovery loads setup, Slack checks and publication status together', t => {
  const previous = process.env.SLACK_OUTBOUND_ENABLED;
  process.env.SLACK_OUTBOUND_ENABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_OUTBOUND_ENABLED;
    else process.env.SLACK_OUTBOUND_ENABLED = previous;
  });
  const loaded = new Set();
  const tools = nativeChatTools(undefined, false, loaded).search('create agent');
  for (const name of ['agents_context', 'agents_draft', 'agents_list', 'agents_read', 'slack_resolve', 'agents_status'])
    assert.ok(tools.includes(name), name);
  assert.ok(tools.length <= 8);
  assert.equal(
    frameworkCallSchema.safeParse({
      tool: 'agents.context',
      channels: ['C123'],
      triggers: [{ kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Kolkata' }],
    }).success,
    true,
  );
  assert.throws(() => previewAgentTriggerCadence({ kind: 'interval', minutes: 30 }), /task-schedule-interval/);
  assert.equal(
    previewAgentTriggerCadence({ kind: 'interval', minutes: 60 }, new Date('2026-10-12T00:00:00.000Z')).nextRunAt,
    '2026-10-12T01:00:00.000Z',
  );
});

test('the chat runtime accepts every framework tool name', () => {
  for (const option of frameworkCallSchema.options) {
    const name = option.shape.tool.value;
    assert.equal(conversationToolNameAllowed(name), true, name);
  }
});
