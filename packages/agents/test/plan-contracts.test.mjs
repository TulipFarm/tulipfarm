import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advancePlan,
  applyPlanMutations,
  buildInitialPlan,
  compilePlan,
  createPlanSchema,
  planLimits,
  planMutationSchema,
  PlanGraphError,
  summarizePlan,
  updatePlanSchema,
} from '../src/plan-contracts.ts';

const coordinator = { actor: { kind: 'coordinator' }, specialists: new Set(['frontend', 'qa']) };
const work = (key, extra = {}) => ({
  key,
  parent: null,
  position: 0,
  kind: 'work',
  order: 'parallel',
  dependsOn: [],
  state: 'pending',
  assignee: null,
  ...extra,
});
const group = (key, extra = {}) => work(key, { kind: 'group', ...extra });
const states = nodes => Object.fromEntries(nodes.map(node => [node.key, node.state]));
const prerequisites = nodes =>
  Object.fromEntries([...compilePlan(nodes).prerequisites].map(([key, needs]) => [key, [...needs].sort()]));
const fails = (fn, code) =>
  assert.throws(fn, error => error instanceof PlanGraphError && error.code === code && error.instruction.length > 0);

function waitlist() {
  return buildInitialPlan(
    createPlanSchema.parse({
      title: 'Build a waitlist',
      specialists: [
        {
          key: 'frontend',
          name: 'Frontend specialist',
          role: 'Builds the page',
          instructions: 'Build and verify.',
          tools: ['web.search'],
        },
        {
          key: 'qa',
          name: 'QA specialist',
          role: 'Checks the result',
          instructions: 'Check every criterion.',
          tools: ['rows.list'],
        },
      ],
      tasks: [
        { key: 'build', kind: 'group', title: 'Build' },
        {
          key: 'frontend',
          parent: 'build',
          title: 'Frontend',
          assignee: { kind: 'specialist', specialist: 'frontend' },
        },
        { key: 'backend', parent: 'build', kind: 'group', order: 'serial', title: 'Backend' },
        { key: 'data-shape', parent: 'backend', title: 'Data shape' },
        { key: 'reads', parent: 'backend', title: 'Reads' },
        { key: 'integration', title: 'Integration', dependsOn: ['build'] },
        { key: 'qa', title: 'QA', dependsOn: ['integration'], assignee: { kind: 'specialist', specialist: 'qa' } },
      ],
    }),
  );
}

test('the waitlist outline compiles parallel branches, a serial group and group barriers', () => {
  assert.throws(
    () => waitlist(),
    error => error.code === 'duplicate-key' && error.key === 'frontend',
  );
  const plan = buildInitialPlan(
    createPlanSchema.parse({
      title: 'Build a waitlist',
      tasks: [
        { key: 'build', kind: 'group', title: 'Build' },
        { key: 'page', parent: 'build', title: 'Frontend' },
        { key: 'backend', parent: 'build', kind: 'group', order: 'serial', title: 'Backend' },
        { key: 'data-shape', parent: 'backend', title: 'Data shape' },
        { key: 'reads', parent: 'backend', title: 'Reads' },
        { key: 'integration', title: 'Integration', dependsOn: ['build'] },
        { key: 'check', title: 'QA', dependsOn: ['integration'] },
      ],
    }),
  );
  assert.deepEqual(prerequisites(plan.nodes), {
    page: [],
    'data-shape': [],
    reads: ['data-shape'],
    integration: ['data-shape', 'page', 'reads'],
    check: ['integration'],
  });
  assert.deepEqual(states(plan.nodes), {
    build: 'pending',
    page: 'ready',
    backend: 'pending',
    'data-shape': 'ready',
    reads: 'pending',
    integration: 'pending',
    check: 'pending',
  });
  const summary = summarizePlan(plan.nodes);
  assert.equal(summary.counts.total, 5);
  assert.equal(summary.counts.ready, 2);
  assert.equal(summary.groups.get('backend').counts.total, 2);
  assert.equal(summary.groups.get('build').counts.total, 3);
});

test('a serial barrier inherits through nested groups and ancestor dependencies apply to descendants', () => {
  const nodes = [
    group('outer', { order: 'serial' }),
    group('first', { parent: 'outer', position: 0 }),
    work('a', { parent: 'first' }),
    work('b', { parent: 'first', position: 1 }),
    group('second', { parent: 'outer', position: 1, dependsOn: ['setup'] }),
    work('c', { parent: 'second' }),
    work('setup', { position: 1 }),
  ];
  assert.deepEqual(prerequisites(nodes), { a: [], b: [], c: ['a', 'b', 'setup'], setup: [] });
});

test('graph validation rejects cycles, hierarchy deadlocks, missing keys and oversize input', () => {
  fails(() => compilePlan([work('a', { dependsOn: ['b'] }), work('b', { dependsOn: ['a'] })]), 'dependency-cycle');
  fails(() => compilePlan([work('a', { dependsOn: ['a'] })]), 'self-dependency');
  fails(() => compilePlan([work('a', { dependsOn: ['ghost'] })]), 'missing-task');
  fails(() => compilePlan([work('a', { parent: 'ghost' })]), 'missing-task');
  fails(() => compilePlan([work('a'), work('a')]), 'duplicate-key');
  fails(() => compilePlan([group('g'), work('a', { parent: 'g', dependsOn: ['g'] })]), 'hierarchy-dependency');
  fails(() => compilePlan([group('g', { dependsOn: ['a'] }), work('a', { parent: 'g' })]), 'hierarchy-dependency');
  fails(() => compilePlan([group('x', { parent: 'y' }), group('y', { parent: 'x' })]), 'hierarchy-cycle');
  fails(
    () => compilePlan([group('g', { assignee: { kind: 'agent', agentId: crypto.randomUUID() } })]),
    'group-assignee',
  );
  const chain = Array.from({ length: planLimits.depth + 1 }, (_, index) =>
    group(`l${index}`, { parent: index ? `l${index - 1}` : null }),
  );
  compilePlan(chain.slice(0, planLimits.depth));
  fails(() => compilePlan(chain), 'too-deep');
  const many = Array.from({ length: planLimits.tasks + 1 }, (_, index) => work(`t${index}`, { position: index }));
  compilePlan(many.slice(0, planLimits.tasks));
  fails(() => compilePlan(many), 'too-many-tasks');
  const wide = work('wide', { dependsOn: many.slice(0, planLimits.dependencies + 1).map(node => node.key) });
  fails(() => compilePlan([...many.slice(0, planLimits.dependencies + 1), wide]), 'too-many-dependencies');
});

test('cross-group cycles are found through group expansion', () => {
  fails(
    () => compilePlan([group('g', { dependsOn: ['b'] }), work('a', { parent: 'g' }), work('b', { dependsOn: ['g'] })]),
    'dependency-cycle',
  );
});

test('only completed prerequisites release work; failures block dependents but not unrelated branches', () => {
  const nodes = [
    work('a', { state: 'failed' }),
    work('b', { dependsOn: ['a'] }),
    work('c', { dependsOn: ['b'] }),
    work('d', { state: 'completed' }),
    work('e', { dependsOn: ['d'] }),
  ];
  assert.deepEqual(advancePlan(nodes), [
    { key: 'b', from: 'pending', to: 'blocked' },
    { key: 'c', from: 'pending', to: 'blocked' },
    { key: 'e', from: 'pending', to: 'ready' },
  ]);
  const blocked = nodes.map(node => ({
    ...node,
    state: { b: 'blocked', c: 'blocked', e: 'completed' }[node.key] ?? node.state,
  }));
  const summary = summarizePlan(blocked);
  assert.equal(summary.outcome, 'failed');
  assert.equal(
    summarizePlan([work('a', { state: 'cancelled' }), work('b', { dependsOn: ['a'], state: 'blocked' })]).outcome,
    'failed',
  );
  assert.equal(
    summarizePlan([work('a', { state: 'cancelled' }), work('b', { state: 'completed' })]).outcome,
    'completed',
  );
  assert.equal(
    summarizePlan([work('a', { state: 'waiting-input' }), work('b', { state: 'completed' })]).outcome,
    'waiting',
  );
  assert.equal(summarizePlan([group('empty')]).outcome, 'empty');
});

test('retrying a failed task unblocks its dependents', () => {
  const nodes = [work('a', { state: 'failed' }), work('b', { dependsOn: ['a'], state: 'blocked' })];
  const result = applyPlanMutations(nodes, [{ op: 'retry', key: 'a' }], coordinator);
  assert.deepEqual(states(result.nodes), { a: 'ready', b: 'pending' });
});

test('dynamic additions may not add prerequisites to started or finished work', () => {
  const nodes = [
    group('build'),
    work('page', { parent: 'build', state: 'running' }),
    work('integration', { dependsOn: ['build'], state: 'pending' }),
  ];
  const added = applyPlanMutations(
    nodes,
    [
      {
        op: 'add',
        task: planMutationSchema.parse({ op: 'add', task: { key: 'api', parent: 'build', title: 'API' } }).task,
      },
    ],
    coordinator,
  );
  assert.deepEqual(prerequisites(added.nodes).integration, ['api', 'page']);
  assert.equal(states(added.nodes).api, 'ready');
  const started = nodes.map(node => (node.key === 'integration' ? { ...node, state: 'running' } : node));
  fails(
    () =>
      applyPlanMutations(
        started,
        [
          {
            op: 'add',
            task: {
              key: 'api',
              parent: 'build',
              kind: 'work',
              order: 'parallel',
              title: 'API',
              brief: '',
              criteria: [],
              dependsOn: [],
              assignee: null,
            },
          },
        ],
        coordinator,
      ),
    'settled-prerequisite',
  );
  fails(
    () =>
      applyPlanMutations(
        [work('a', { state: 'completed' }), work('b')],
        [{ op: 'depend', key: 'a', on: 'b' }],
        coordinator,
      ),
    'settled-prerequisite',
  );
  fails(
    () =>
      applyPlanMutations([work('a', { state: 'running' })], [{ op: 'revise', key: 'a', title: 'New' }], coordinator),
    'settled-task',
  );
});

test('a worker may add subtasks only under its own task, which yields until they finish', () => {
  const nodes = [work('backend', { state: 'running' }), work('frontend', { state: 'running', position: 1 })];
  const worker = { actor: { kind: 'worker', task: 'backend' }, specialists: new Set() };
  const task = key => ({
    key,
    parent: 'backend',
    kind: 'work',
    order: 'parallel',
    title: key,
    brief: '',
    criteria: [],
    dependsOn: [],
    assignee: null,
  });
  const result = applyPlanMutations(
    nodes,
    [
      { op: 'add', task: task('schema') },
      { op: 'add', task: { ...task('routes'), dependsOn: ['schema'] } },
    ],
    worker,
  );
  assert.equal(result.yielded, true);
  assert.deepEqual(states(result.nodes), {
    backend: 'pending',
    frontend: 'running',
    schema: 'ready',
    routes: 'pending',
  });
  fails(
    () => applyPlanMutations(nodes, [{ op: 'add', task: { ...task('x'), parent: null } }], worker),
    'outside-scope',
  );
  fails(
    () => applyPlanMutations(nodes, [{ op: 'add', task: { ...task('x'), dependsOn: ['frontend'] } }], worker),
    'outside-scope',
  );
  fails(() => applyPlanMutations(nodes, [{ op: 'cancel', key: 'frontend', reason: 'No' }], worker), 'outside-scope');
  fails(() => applyPlanMutations(nodes, [{ op: 'cancel', key: 'backend', reason: 'No' }], worker), 'outside-scope');
});

test('QA can add a repair and recheck without a cycle and the plan stays unfinished', () => {
  const nodes = [work('build', { state: 'completed' }), work('qa', { dependsOn: ['build'], state: 'running' })];
  const qa = { actor: { kind: 'worker', task: 'qa' }, specialists: new Set() };
  const task = (key, dependsOn = []) => ({
    key,
    parent: 'qa',
    kind: 'work',
    order: 'parallel',
    title: key,
    brief: '',
    criteria: [],
    dependsOn,
    assignee: null,
  });
  const result = applyPlanMutations(
    nodes,
    [
      { op: 'add', task: task('repair') },
      { op: 'add', task: task('recheck', ['repair']) },
    ],
    qa,
  );
  assert.deepEqual(states(result.nodes), { build: 'completed', qa: 'pending', repair: 'ready', recheck: 'pending' });
  assert.equal(summarizePlan(result.nodes).outcome, 'active');
});

test('assignments must resolve to declared specialists and cancelling a group cancels unsettled work', () => {
  fails(
    () =>
      applyPlanMutations(
        [work('a')],
        [{ op: 'assign', key: 'a', assignee: { kind: 'specialist', specialist: 'ghost' } }],
        coordinator,
      ),
    'missing-specialist',
  );
  const nodes = [
    group('g'),
    work('a', { parent: 'g', state: 'completed' }),
    work('b', { parent: 'g', position: 1 }),
    work('after', { dependsOn: ['g'] }),
  ];
  const result = applyPlanMutations(nodes, [{ op: 'cancel', key: 'g', reason: 'Out of scope' }], coordinator);
  assert.deepEqual(states(result.nodes), { g: 'pending', a: 'completed', b: 'cancelled', after: 'blocked' });
  assert.equal(result.nodes.find(node => node.key === 'b').reason, 'Out of scope');
});

test('input schemas bound text, keys, batches and specialist tools', () => {
  assert.equal(createPlanSchema.safeParse({ title: 'x', tasks: [] }).success, false);
  assert.equal(createPlanSchema.safeParse({ title: 'x', tasks: [{ key: 'Bad Key', title: 'x' }] }).success, false);
  assert.equal(
    createPlanSchema.safeParse({ title: 'x'.repeat(planLimits.title + 1), tasks: [{ key: 'a', title: 'x' }] }).success,
    false,
  );
  assert.equal(
    createPlanSchema.safeParse({
      title: 'x',
      tasks: [{ key: 'a', title: 'x' }],
      specialists: [{ key: 's', name: 'S', role: 'r', instructions: 'i', tools: ['rows.create'] }],
    }).success,
    false,
  );
  assert.equal(
    createPlanSchema.safeParse({
      title: 'x',
      tasks: [{ key: 'a', title: 'x' }],
      specialists: [{ key: 's', name: 'S', role: 'r', instructions: 'i', tools: ['web.search', 'web.search'] }],
    }).success,
    false,
  );
  assert.equal(
    createPlanSchema.safeParse({ title: 'x', tasks: [{ key: 'a', title: 'x' }], budget: { credits: 10001 } }).success,
    false,
  );
  const mutation = { op: 'retry', key: 'a' };
  assert.equal(
    updatePlanSchema.safeParse({ expectedVersion: 0, mutations: Array(planLimits.mutations).fill(mutation) }).success,
    true,
  );
  assert.equal(
    updatePlanSchema.safeParse({ expectedVersion: 0, mutations: Array(planLimits.mutations + 1).fill(mutation) })
      .success,
    false,
  );
  assert.deepEqual(createPlanSchema.parse({ title: ' Plan ', tasks: [{ key: 'a', title: 'A' }] }).tasks[0], {
    key: 'a',
    parent: null,
    kind: 'work',
    order: 'parallel',
    title: 'A',
    brief: '',
    criteria: [],
    dependsOn: [],
    assignee: null,
  });
});
