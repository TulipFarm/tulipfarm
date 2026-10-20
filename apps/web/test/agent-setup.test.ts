import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentSetup, agentStatus, visibleTabs } from '../src/features/agents/setup.ts';

const saved = 'a'.repeat(64);
const earlier = 'b'.repeat(64);
const activation = (revision: string) => ({ id: '11111111-1111-4111-8111-111111111111', revision, scope: [] });
const manager = ['read', 'edit', 'delete', 'manage'];
const summary = (steps: ReturnType<typeof agentSetup>) =>
  steps.map(step => [step.id, step.status, step.detail, step.link?.label ?? null]);

test('a new agent shows its draft status and the steps that make it runnable, in order', () => {
  const detail = { activations: [], definitionRevision: saved, capabilities: manager };
  assert.deepEqual(agentStatus(detail, 'off'), { kind: 'draft', label: 'Draft' });
  assert.deepEqual(summary(agentSetup({ detail, execution: 'off', model: { kind: 'none' } })), [
    ['instructions', 'done', 'The instructions are saved.', 'Edit instructions'],
    ['execution', 'todo', 'Check Enable execution, then save execution settings.', 'Go to Enable execution'],
    ['activation', 'waiting', 'Available after execution is turned on and saved in step 2.', null],
    ['access', 'todo', 'Give yourself or one of your teams the invoke permission, then save sharing.', 'Go to Access'],
    ['model', 'done', 'No saved preference. The runtime must supply an available model.', null],
  ]);
});

test('each manager step links to the tab and control that completes it', () => {
  const detail = { activations: [], definitionRevision: saved, capabilities: manager };
  const links = agentSetup({ detail, execution: 'on', model: { kind: 'unavailable' } }).map(step => step.link);
  assert.deepEqual(links, [
    { kind: 'tab', label: 'Edit instructions', tab: 'instructions', target: 'agent-instructions' },
    undefined,
    { kind: 'tab', label: 'Go to Activate', tab: 'execution', target: 'agent-activate' },
    { kind: 'tab', label: 'Go to Access', tab: 'access', target: 'agent-ownership' },
    { kind: 'models', label: 'Open model access' },
  ]);
});

test('an agent running earlier instructions asks a manager to activate the current ones', () => {
  const detail = {
    activations: [activation(earlier)],
    definitionRevision: saved,
    capabilities: [...manager, 'invoke'],
  };
  assert.deepEqual(agentStatus(detail, 'on'), { kind: 'earlier', label: 'Active, earlier instructions' });
  assert.deepEqual(
    summary(agentSetup({ detail, execution: 'on', model: { kind: 'available', name: 'GPT Luna' } })).slice(2),
    [
      [
        'activation',
        'todo',
        'An earlier version is active. Activate the current saved instructions to use your latest changes.',
        'Go to Activate',
      ],
      ['access', 'done', 'You can start tasks with this agent.', null],
      ['model', 'done', 'GPT Luna is available.', null],
    ],
  );
});

test('a person who can only run the agent sees what they are waiting on, without manager links', () => {
  const detail = { activations: [], definitionRevision: saved, capabilities: ['read', 'invoke'] };
  assert.deepEqual(summary(agentSetup({ detail, execution: 'hidden', model: { kind: 'error' } })), [
    ['instructions', 'done', 'The instructions are saved.', null],
    ['activation', 'waiting', 'An agent manager must turn on execution and activate the saved instructions.', null],
    ['access', 'done', 'You can start tasks with this agent.', null],
    ['model', 'todo', 'Model availability could not be checked.', 'Check model availability again'],
  ]);
});

test('an active agent is ready once execution is on and the person can run it', () => {
  const detail = { activations: [activation(saved)], definitionRevision: saved, capabilities: [...manager, 'invoke'] };
  assert.deepEqual(agentStatus(detail, 'on'), { kind: 'active', label: 'Active' });
  assert.deepEqual(
    agentSetup({ detail, execution: 'on', model: { kind: 'none' } }).map(step => step.status),
    ['done', 'done', 'done', 'done', 'done'],
  );
});

test('turning execution off after activation is not reported as active or ready', () => {
  const detail = { activations: [activation(saved)], definitionRevision: saved, capabilities: [...manager, 'invoke'] };
  assert.deepEqual(agentStatus(detail, 'off'), { kind: 'off', label: 'Execution off' });
  assert.deepEqual(summary(agentSetup({ detail, execution: 'off', model: { kind: 'none' } })).slice(1, 3), [
    ['execution', 'todo', 'Check Enable execution, then save execution settings.', 'Go to Enable execution'],
    ['activation', 'done', 'The current saved instructions are active.', null],
  ]);
});

test('a runner who cannot read execution settings is not told execution is on', () => {
  const detail = { activations: [activation(saved)], definitionRevision: saved, capabilities: ['read', 'invoke'] };
  assert.deepEqual(agentStatus(detail, 'hidden'), { kind: 'active', label: 'Active' });
  assert.deepEqual(
    summary(agentSetup({ detail, execution: 'hidden', model: { kind: 'none' } })).map(([id]) => id),
    ['instructions', 'activation', 'access', 'model'],
  );
  assert.equal(
    agentSetup({ detail, execution: 'hidden', model: { kind: 'none' } })[1].detail,
    'The current saved instructions are active. An agent manager controls execution, which is checked when work starts.',
  );
});

test('a manager whose execution settings failed to load is sent to retry them, not told to activate', () => {
  const detail = { activations: [], definitionRevision: saved, capabilities: manager };
  assert.deepEqual(summary(agentSetup({ detail, execution: 'error', model: { kind: 'none' } })).slice(1, 3), [
    ['execution', 'todo', 'Execution settings could not load.', 'Go to Execution'],
    ['activation', 'waiting', 'Available after execution settings load.', null],
  ]);
});

test('sections appear only to people who can use them', () => {
  assert.deepEqual(
    visibleTabs(['read']).map(tab => tab.label),
    ['Overview', 'Settings'],
  );
  assert.deepEqual(
    visibleTabs(['read', 'invoke']).map(tab => tab.label),
    ['Overview', 'Slack', 'Settings'],
  );
  assert.deepEqual(
    visibleTabs([...manager, 'invoke']).map(tab => tab.label),
    ['Overview', 'Instructions', 'Access', 'Execution', 'Slack', 'Triggers', 'Settings'],
  );
});
