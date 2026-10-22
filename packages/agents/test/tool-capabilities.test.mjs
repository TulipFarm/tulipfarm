import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentDefinitionSchema,
  agentRuntimeToolNames,
  agentToolRuntimeDescription,
  supportedAgentToolRuntimes,
  toolNameSchema,
} from '../dist/contracts.js';
import { modelNativeTools, parseModelDecision } from '../dist/model.js';

test('saved-agent selectable tools come only from supported runtime profiles', () => {
  for (const runtimeTools of Object.values(agentRuntimeToolNames)) {
    for (const tool of runtimeTools) assert.ok(toolNameSchema.options.includes(tool), `${tool} is selectable`);
  }
  assert.deepEqual(
    toolNameSchema.options.filter(tool => supportedAgentToolRuntimes(tool).length === 0),
    [],
  );
  assert.equal(
    agentDefinitionSchema.safeParse({
      name: 'Calendar helper',
      instructions: 'Check the calendar',
      tools: ['google.read'],
    }).success,
    true,
  );
  assert.equal(
    agentDefinitionSchema.safeParse({ name: 'Issue helper', instructions: 'Read issues', tools: ['github.issue.read'] })
      .success,
    true,
  );
  assert.equal(
    agentDefinitionSchema.safeParse({ name: 'Unsupported', instructions: 'Do work', tools: ['files.create'] }).success,
    false,
  );
});

test('task-based runtimes and Slack channel agents advertise distinct support', () => {
  assert.strictEqual(agentRuntimeToolNames.schedule, agentRuntimeToolNames.task);
  assert.strictEqual(agentRuntimeToolNames.workflowStep, agentRuntimeToolNames.task);
  assert.deepEqual(supportedAgentToolRuntimes('google.read'), ['slackChannel']);
  assert.deepEqual(supportedAgentToolRuntimes('github.issue.read'), ['slackChannel']);
  assert.deepEqual(supportedAgentToolRuntimes('github.personal.read'), ['task', 'schedule', 'workflowStep']);
  for (const tool of ['skills.execute', 'skills.files.read']) {
    assert.deepEqual(supportedAgentToolRuntimes(tool), ['task', 'schedule', 'workflowStep']);
  }
  assert.equal(agentToolRuntimeDescription('google.read'), 'Available to Slack channel agents.');
  assert.equal(agentToolRuntimeDescription('rows.update'), 'Available to private tasks, schedules, workflow steps.');
  assert.equal(supportedAgentToolRuntimes('files.create').length, 0);
});

test('model tool catalogs follow each runtime profile', () => {
  const names = input => modelNativeTools({ prompt: 'Work', scope: [], ...input }).tools.map(tool => tool.name);
  const task = names({
    definition: { name: 'Agent', instructions: 'Work', tools: ['google.read', 'github.personal.read'] },
    task: true,
  });
  assert.equal(task.includes('github_personal_read'), true);
  assert.equal(task.includes('google_read'), false);

  const slack = names({
    definition: {
      name: 'Agent',
      instructions: 'Work',
      tools: ['google.read', 'github.issue.read', 'github.personal.read'],
    },
    runtime: 'slackChannel',
  });
  assert.equal(slack.includes('google_read'), true);
  assert.equal(slack.includes('github_issue_read'), true);
  assert.equal(slack.includes('github_personal_read'), false);
  const packageTools = ['skills.execute', 'skills.files.read'];
  const taskPackages = names({ definition: { name: 'Agent', instructions: 'Work', tools: packageTools }, task: true });
  const slackPackages = names({
    definition: { name: 'Agent', instructions: 'Work', tools: packageTools },
    runtime: 'slackChannel',
  });
  for (const tool of packageTools) {
    assert.equal(taskPackages.includes(tool.replaceAll('.', '_')), true);
    assert.equal(slackPackages.includes(tool.replaceAll('.', '_')), false);
  }
});

test('task decision parsing rejects calls supported only by saved-agent chat', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const input = {
    prompt: 'Read the issue',
    definition: { name: 'Issue helper', instructions: 'Read issues', tools: ['github.issue.read'] },
    scope: [],
    task: true,
  };
  const decision = {
    kind: 'tool',
    text: 'Read issue',
    call: { tool: 'github.issue.read', integrationId: id, sourceId: id, issueNumber: 17 },
  };
  assert.throws(() => parseModelDecision(decision, input), /tool-not-admitted/);
  const privateRead = {
    ...decision,
    call: { tool: 'github.personal.read', operation: { kind: 'issue.search', query: 'invoice' } },
  };
  const taskOnlyDefinition = { ...input.definition, tools: ['github.personal.read'] };
  assert.throws(
    () =>
      parseModelDecision(privateRead, {
        ...input,
        task: undefined,
        definition: taskOnlyDefinition,
        runtime: 'slackChannel',
      }),
    /tool-not-admitted/,
  );
  assert.equal(
    parseModelDecision(privateRead, { ...input, task: undefined, definition: taskOnlyDefinition }).call.tool,
    'github.personal.read',
  );
  assert.deepEqual(parseModelDecision(decision, { ...input, task: undefined, runtime: 'slackChannel' }), decision);
});
