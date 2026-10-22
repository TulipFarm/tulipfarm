import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitionSchema, nextStep, runCondition, type Definition, type Step } from '@tulipfarm/workflows/contracts';
import { workflowDuration, workflowGraph } from '../src/features/workflows/diagram-model.ts';
import {
  mockPhases,
  mockScenarios,
  mockTriggers,
  mockWorkflowView,
} from '../src/features/workflows/workflow-mock-api.ts';

const step = (id: string): Step => ({ id, kind: 'transform', fields: {} });
const check = (id: string, ifMet: string[], otherwise: string[]): Step => ({
  id,
  kind: 'condition',
  when: { left: { kind: 'literal', value: 1 }, op: 'eq', right: { kind: 'literal', value: 1 } },
  ifMet,
  otherwise,
});
const definition = (steps: Step[]): Definition =>
  definitionSchema.parse({ version: 1, name: 'Request review', trigger: { kind: 'manual' }, steps });
const labels = { actor: 'Run requester' };

test('each mock uses a valid definition for every display state and trigger', () => {
  for (const scenario of Object.keys(mockScenarios) as (keyof typeof mockScenarios)[]) {
    for (const phase of Object.keys(mockPhases) as (keyof typeof mockPhases)[]) {
      const view = mockWorkflowView(scenario, phase);
      assert.equal(definitionSchema.safeParse(view.definition).success, true, `${scenario}:${phase}`);
      const graph = workflowGraph(view.definition, view.labels, view.run?.states);
      assert.equal(graph.nodes.length, view.definition.steps.length + 1);
      assert.equal(new Set(graph.nodes.map(node => node.id)).size, graph.nodes.length);
      assert.equal(new Set(graph.edges.map(edge => edge.id)).size, graph.edges.length);
      assert.ok(
        graph.edges.every(
          edge =>
            graph.nodes.some(node => node.id === edge.source) && graph.nodes.some(node => node.id === edge.target),
        ),
      );
    }
  }
  for (const trigger of Object.values(mockTriggers)) {
    const view = mockWorkflowView('catalog', 'draft', trigger);
    assert.equal(view.definition.trigger.kind, trigger.kind);
    assert.ok(workflowGraph(view.definition, view.labels).nodes[0]?.summary);
  }
});

test('all twelve step types and the 32-step limit have inspectable content', () => {
  const catalog = mockWorkflowView('catalog', 'draft');
  const graph = workflowGraph(catalog.definition, catalog.labels);
  assert.equal(new Set(graph.nodes.slice(1).map(node => node.kind)).size, 12);
  assert.ok(graph.nodes.every(node => graph.details[node.id]?.configuration));
  const long = mockWorkflowView('long', 'draft');
  assert.equal(workflowGraph(long.definition, long.labels).nodes.length, 33);
  assert.equal(workflowGraph(definition([step('only')]), labels).nodes.length, 2);
});

test('definition order is stable and branch arrays never reorder execution', () => {
  const source = definition([check('check', ['last', 'first'], []), step('first'), step('always'), step('last')]);
  const before = structuredClone(source);
  const graph = workflowGraph(source, labels);
  assert.deepEqual(
    graph.nodes.map(node => node.id),
    ['$trigger', 'check', 'first', 'always', 'last'],
  );
  assert.deepEqual(graph.details.always?.gates, []);
  const outputs = new Map([
    ['check', runCondition(source.steps[0] as Extract<Step, { kind: 'condition' }>, {}, new Map())],
  ]);
  assert.equal(nextStep(source.steps, outputs)?.step.id, 'first');
  const refreshed = workflowGraph(source, labels, { $trigger: 'completed', check: 'completed', first: 'active' });
  assert.deepEqual(
    refreshed.nodes.map(({ id, position }) => ({ id, position })),
    graph.nodes.map(({ id, position }) => ({ id, position })),
  );
  assert.deepEqual(source, before, 'conversion does not mutate the definition');
});

test('nested, shared, and interleaved gates use the same conjunction as the scheduler', () => {
  const source = definition([
    check('outer', ['inner'], ['alternative']),
    check('inner', ['shared'], []),
    step('always'),
    step('shared'),
    step('alternative'),
  ]);
  const graph = workflowGraph(source, labels);
  assert.deepEqual(
    graph.details.shared?.gates.map(gate => [gate.stepId, gate.choice]),
    [
      ['inner', 'Yes'],
      ['outer', 'Yes'],
    ],
  );
  const outputs = new Map<string, unknown>([['outer', { matched: false, ran: ['alternative'], skipped: ['inner'] }]]);
  assert.equal(nextStep(source.steps, outputs)?.step.id, 'always');
  outputs.set('always', {});
  assert.equal(nextStep(source.steps, outputs)?.step.id, 'alternative');
  outputs.set('alternative', {});
  assert.equal(nextStep(source.steps, outputs), null, 'skipped conditions do not unlock their descendants');
});

test('multiple conditions gate a target without becoming parallel tasks', () => {
  const source = definition([check('first', ['shared'], []), check('second', [], ['shared']), step('shared')]);
  const graph = workflowGraph(source, labels);
  assert.deepEqual(
    graph.details.shared?.gates.map(gate => [gate.stepId, gate.choice]),
    [
      ['first', 'Yes'],
      ['second', 'No'],
    ],
  );
  assert.deepEqual(
    graph.nodes.map(node => node.ordinal),
    [0, 1, 2, 3],
  );
});

test('run omissions stay unknown and references resolve to readable step names', () => {
  const view = mockWorkflowView('pr', 'draft');
  const graph = workflowGraph(view.definition, view.labels, {});
  assert.ok(graph.nodes.every(node => node.state === 'unknown'));
  assert.deepEqual(graph.details.notify?.references, [{ stepId: 'prepare', label: 'Prepare PR summary' }]);
  const waiting = mockWorkflowView('agent', 'waiting');
  assert.equal(waiting.run?.states.decision, 'waiting');
  assert.equal(waiting.run?.states.notify, 'pending');
  for (const phase of ['queued', 'failed', 'blocked', 'cancelled', 'skipped'] as const) {
    assert.ok(!Object.values(mockWorkflowView('pr', phase).run!.states).includes('active'));
  }
});

test('taken paths cross only proven skipped steps, never unknown work', () => {
  const view = mockWorkflowView('branch-no', 'completed');
  const graph = workflowGraph(view.definition, view.labels, view.run?.states);
  assert.equal(
    graph.edges.find(edge => edge.source === 'check_amount' && edge.target === 'record')?.state,
    'completed',
  );
  assert.ok(
    !graph.edges.some(edge => edge.source === 'review' && edge.target === 'record'),
    'exclusive branches are not chained together',
  );
  const unknown = workflowGraph(view.definition, view.labels, {
    $trigger: 'completed',
    check_amount: 'completed',
    review: 'unknown',
    record: 'active',
    notify: 'pending',
  });
  assert.ok(!unknown.edges.some(edge => edge.kind === 'route' || edge.state === 'active'));
  const queued = mockWorkflowView('agent', 'queued');
  assert.equal(queued.run?.task, undefined);
  assert.equal(queued.labels.actor, 'Run requester');
  assert.equal(
    mockWorkflowView('approval', 'running').run?.states.record,
    'pending',
    'an unfinished condition cannot prove a branch skipped',
  );
});

test('conditions spread into exclusive tree lanes and rejoin later work', () => {
  const view = mockWorkflowView('approval', 'draft');
  const graph = workflowGraph(view.definition, view.labels);
  const node = (id: string) => graph.nodes.find(node => node.id === id)!;
  assert.equal(node('review').position.y, node('record').position.y);
  assert.ok(node('review').position.x < node('check_amount').position.x);
  assert.ok(node('record').position.x > node('check_amount').position.x);
  assert.equal(node('notify').position.x, node('check_amount').position.x);
  assert.deepEqual(
    graph.edges.map(edge => [edge.source, edge.target, edge.label]),
    [
      ['$trigger', 'check_amount', undefined],
      ['check_amount', 'review', 'Yes'],
      ['check_amount', 'record', 'No'],
      ['review', 'notify', undefined],
      ['record', 'notify', undefined],
    ],
  );
  const nested = mockWorkflowView('nested', 'draft');
  const tree = workflowGraph(nested.definition, nested.labels);
  assert.equal(new Set(tree.nodes.map(node => node.position.x)).size >= 3, true);
  assert.equal(tree.edges.length, tree.nodes.length - 1, 'inherited gates do not add redundant long arcs');
  for (const [index, node] of tree.nodes.entries())
    for (const other of tree.nodes.slice(index + 1)) {
      assert.ok(
        Math.abs(node.position.x - other.position.x) >= 280 || Math.abs(node.position.y - other.position.y) >= 136,
        'cards do not overlap',
      );
    }
});

test('interleaved work retains order and multiple gates remain explicit', () => {
  const source = definition([check('check', ['first', 'last'], []), step('first'), step('always'), step('last')]);
  const graph = workflowGraph(source, labels);
  assert.ok(graph.nodes.every((node, index) => !index || node.position.y > graph.nodes[index - 1]!.position.y));
  assert.equal(graph.edges.find(edge => edge.source === 'check' && edge.target === 'always')?.label, 'No');
  const overlapping = workflowGraph(
    definition([check('one', ['shared'], []), check('two', [], ['shared']), step('shared')]),
    labels,
  );
  assert.equal(overlapping.details.shared?.gates.length, 2);
  assert.equal(overlapping.edges.find(edge => edge.source === 'one' && edge.target === 'shared')?.kind, 'requirement');
});

test('app identities and authorized agent avatars travel with the shared graph', () => {
  const pr = mockWorkflowView('pr', 'draft');
  const graph = workflowGraph(pr.definition, pr.labels);
  assert.deepEqual(graph.nodes[0]?.identity, { kind: 'app', brand: 'github' });
  assert.deepEqual(graph.nodes.at(-1)?.identity, { kind: 'app', brand: 'slack' });
  const provider = mockWorkflowView('provider', 'draft');
  const providerGraph = workflowGraph(provider.definition, provider.labels);
  assert.deepEqual(providerGraph.nodes[0]?.identity, { kind: 'app', brand: 'google-sheets' });
  assert.equal(providerGraph.nodes[1]?.identity?.kind, 'agent');
  assert.equal(
    workflowGraph(provider.definition, { actor: 'Run requester' }).nodes[1]?.identity,
    undefined,
    'unavailable agents do not leak an avatar',
  );
});

test('delay and wait-until display readable times consistently in the inspector', () => {
  assert.equal(workflowDuration(1800), '30 minutes');
  assert.equal(workflowDuration(90061), '1 day 1 hour 1 minute 1 second');
  assert.equal(workflowDuration(60), '1 minute');
  const view = mockWorkflowView('waiting', 'draft');
  const graph = workflowGraph(view.definition, view.labels);
  assert.equal(graph.nodes.find(node => node.id === 'pause')?.summary, '30 minutes');
  const date = graph.nodes.find(node => node.id === 'due')!.summary;
  assert.match(date, /2027/);
  assert.match(date, /9:00/);
  assert.ok(!date.includes('2027-01-12T03:30:00Z'));
  assert.equal(graph.details.due?.facts[0]?.value, date);
  const dynamic = workflowGraph(
    definition([{ id: 'due', kind: 'wait-until', at: { kind: 'input', path: ['due'] } }]),
    labels,
  );
  assert.equal(dynamic.nodes[1]?.summary, 'Date from an earlier input');
});
