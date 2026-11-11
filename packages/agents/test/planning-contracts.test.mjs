import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInitialPlan,
  createPlanSchema,
  parsePlanWorkerReport,
  planReportSchema,
  validatePlanning,
  validatePlanReport,
  summarizePlan,
  updatePlanSchema,
} from '../src/plan-contracts.ts';

const owner = { kind: 'coordinator' };
const evidence = [{ callId: '00000000-0000-4000-8000-000000000001', summary: 'Read the active setup receipt.' }];
function input() {
  return createPlanSchema.parse({
    title: 'Alert triage',
    planning: {
      requirements: [{ key: 'triage', description: 'An active alert triage agent', tasks: ['agent'] }],
      prerequisites: [{ key: 'slack', title: 'Slack channel access', status: 'verified', tasks: ['agent'], evidence }],
      verificationTask: 'verify',
    },
    tasks: [
      { key: 'agent', title: 'Create the agent', criteria: ['Agent is active'], assignee: owner },
      {
        key: 'verify',
        title: 'Verify the request',
        criteria: ['An active alert triage agent'],
        dependsOn: ['agent'],
        assignee: owner,
      },
    ],
  });
}

test('Planning keeps the main agent as owner and requires complete request coverage', () => {
  const plan = input();
  const built = buildInitialPlan(plan);
  assert.deepEqual(built.nodes[0].assignee, owner);
  assert.doesNotThrow(() => validatePlanning(built.nodes, plan.planning));
  assert.throws(() => buildInitialPlan({ ...plan, planning: undefined }), /planning-required/);
  assert.throws(
    () => buildInitialPlan({ ...plan, planning: { ...plan.planning, requirements: [] } }),
    /planning-coverage/,
  );
  const uncovered = buildInitialPlan({
    ...plan,
    tasks: [
      ...plan.tasks.map(task => (task.key === 'verify' ? { ...task, dependsOn: ['agent', 'unrequested'] } : task)),
      { ...plan.tasks[0], key: 'unrequested' },
    ],
  });
  assert.doesNotThrow(() => validatePlanning(uncovered.nodes, uncovered.planning));
});

test('creating a structured draft fills omitted work criteria and ownership', () => {
  const plan = input();
  const minimal = createPlanSchema.parse({
    ...plan,
    execution: 'plan-only',
    tasks: [{ key: 'agent', title: 'Create the agent' }, plan.tasks[1]],
  });
  const built = buildInitialPlan(minimal);
  assert.deepEqual(built.nodes[0].assignee, owner);
  assert.deepEqual(built.nodes[0].criteria, ['Create the agent']);
  assert.doesNotThrow(() => validatePlanning(built.nodes, plan.planning));
  assert.deepEqual(minimal.tasks[0].criteria, [], 'normalization does not mutate the supplied command');
  assert.equal(minimal.tasks[0].assignee, null);
});

test('creating a structured draft preserves explicit criteria and delegated ownership', () => {
  const plan = input();
  const assigned = { kind: 'agent', agentId: '00000000-0000-4000-8000-000000000001' };
  const built = buildInitialPlan({
    ...plan,
    tasks: [{ ...plan.tasks[0], assignee: assigned }, plan.tasks[1]],
  });
  assert.deepEqual(built.nodes[0].assignee, assigned);
  assert.deepEqual(built.nodes[0].criteria, plan.tasks[0].criteria);
});

test('final verification must wait for every deliverable and remain coordinator-owned', () => {
  const plan = input();
  assert.throws(
    () => buildInitialPlan({ ...plan, tasks: [plan.tasks[0], { ...plan.tasks[1], dependsOn: [] }] }),
    /planning-verification/,
  );
  const automatic = buildInitialPlan({ ...plan, planning: { ...plan.planning, verificationTask: 'missing' } });
  assert.equal(automatic.planning.verificationTask, 'missing');
  assert.deepEqual(automatic.nodes.at(-1).dependsOn, ['agent', 'verify']);
  assert.throws(
    () =>
      buildInitialPlan({
        ...plan,
        tasks: [
          plan.tasks[0],
          {
            ...plan.tasks[1],
            assignee: { kind: 'agent', agentId: '00000000-0000-4000-8000-000000000001' },
          },
        ],
      }),
    /planning-verification/,
  );
});

test('creation supplies a final coordinator check and coverage without relaxing updates', () => {
  const plan = createPlanSchema.parse({
    title: 'Release outline',
    execution: 'plan-only',
    planning: {
      requirements: [{ key: 'prepare', description: 'Prepare release', tasks: ['prepare'] }],
    },
    tasks: [
      { key: 'prepare', title: 'Prepare release' },
      { key: 'review', title: 'Review release' },
    ],
  });
  const built = buildInitialPlan(plan);
  const verification = built.nodes.find(node => node.key === built.planning.verificationTask);
  assert.equal(verification.title, 'Check the work is done');
  assert.deepEqual(verification.criteria, ['Every other task in this plan is confirmed done.']);
  assert.deepEqual(verification.assignee, owner);
  assert.deepEqual(verification.dependsOn, ['prepare', 'review']);
  assert.deepEqual(built.planning.requirements, [
    { key: 'prepare', description: 'Prepare release', tasks: ['prepare'] },
    { key: 'review', description: 'Review release', tasks: ['review'] },
  ]);
  assert.doesNotThrow(() => validatePlanning(built.nodes, built.planning));
  assert.throws(
    () => validatePlanning(built.nodes, { ...built.planning, requirements: [built.planning.requirements[0]] }),
    /planning-coverage/,
  );
  assert.equal(updatePlanSchema.safeParse({ expectedVersion: 0, planning: { requirements: [] } }).success, false);
});

test('creation adopts a supplied coordinator final check when its key is omitted', () => {
  const plan = input();
  const { verificationTask: _verificationTask, ...planning } = plan.planning;
  const built = buildInitialPlan(createPlanSchema.parse({ ...plan, planning }));
  assert.equal(built.planning.verificationTask, 'verify');
  assert.deepEqual(
    built.nodes.map(task => task.key),
    ['agent', 'verify'],
  );
  assert.deepEqual(built.planning.requirements, plan.planning.requirements);
  assert.deepEqual(built.nodes[1].criteria, plan.tasks[1].criteria);
});

test('an omitted final check key does not steal a deliverable key', () => {
  const plan = createPlanSchema.parse({
    title: 'Release outline',
    planning: {
      requirements: [{ key: 'release', description: 'Prepare and review', tasks: ['verify-request', 'review'] }],
    },
    tasks: [
      { key: 'verify-request', title: 'Prepare release' },
      { key: 'review', title: 'Review release' },
    ],
  });
  const built = buildInitialPlan(plan);
  assert.equal(built.planning.verificationTask, 'verify-request-1');
  assert.deepEqual(built.nodes.at(-1).dependsOn, ['verify-request', 'review']);
  assert.deepEqual(built.planning.requirements, plan.planning.requirements);
});

test('updating a plan cannot silently remove or rewrite an original requirement', () => {
  const plan = input();
  const { nodes } = buildInitialPlan(plan);
  assert.throws(
    () => validatePlanning(nodes, { ...plan.planning, requirements: [] }, plan.planning),
    /planning-coverage/,
  );
  assert.throws(
    () =>
      validatePlanning(
        nodes,
        {
          ...plan.planning,
          requirements: [{ ...plan.planning.requirements[0], description: 'Just propose an agent' }],
        },
        plan.planning,
      ),
    /planning-coverage/,
  );
});

test('blocked prerequisites remain attached to the affected tasks', () => {
  const plan = input();
  const blocked = {
    ...plan.planning.prerequisites[0],
    status: 'blocked',
    evidence: [],
    reason: 'Connect Slack first.',
  };
  assert.equal(
    buildInitialPlan({ ...plan, planning: { ...plan.planning, prerequisites: [blocked] } }).nodes[0].state,
    'blocked',
  );
  assert.equal(
    summarizePlan(buildInitialPlan({ ...plan, planning: { ...plan.planning, prerequisites: [blocked] } }).nodes)
      .outcome,
    'waiting',
  );
  assert.throws(
    () => validatePlanning(buildInitialPlan(plan).nodes, { ...plan.planning, prerequisites: [] }, plan.planning),
    /planning-prerequisite/,
  );
  assert.doesNotThrow(() => updatePlanSchema.parse({ expectedVersion: 0, planning: plan.planning }));
  assert.throws(() => updatePlanSchema.parse({ expectedVersion: 0, mutations: [] }));
  assert.throws(
    () =>
      buildInitialPlan({
        ...plan,
        planning: { ...plan.planning, prerequisites: [{ ...blocked, tasks: ['missing'] }] },
      }),
    /planning-prerequisite/,
  );
});

test('a successful report needs every criterion and supporting receipts', () => {
  const plan = input();
  const { nodes } = buildInitialPlan(plan);
  const report = planReportSchema.parse({
    outcome: 'passed',
    summary: 'Active setup read back.',
    checks: [{ criterion: 0, outcome: 'passed', evidence }],
  });
  assert.doesNotThrow(() => validatePlanReport(nodes[0], plan.planning, report, nodes));
  assert.throws(
    () => validatePlanReport(nodes[0], plan.planning, { ...report, checks: [] }, nodes),
    /planning-evidence/,
  );
  assert.throws(
    () =>
      validatePlanReport(
        nodes[0],
        plan.planning,
        { ...report, checks: [{ ...report.checks[0], evidence: [] }] },
        nodes,
      ),
    /planning-evidence/,
  );
  assert.throws(
    () =>
      validatePlanReport(
        nodes[0],
        plan.planning,
        { ...report, checks: [{ ...report.checks[0], outcome: 'unknown' }] },
        nodes,
      ),
    /planning-evidence/,
  );
});

test('a limitation report is not success and final verification cannot skip unfinished work', () => {
  const plan = input();
  const { nodes } = buildInitialPlan(plan);
  const blocked = planReportSchema.parse({
    outcome: 'blocked',
    summary: 'I could not inspect any accessible table.',
    checks: [],
  });
  assert.doesNotThrow(() => validatePlanReport(nodes[0], plan.planning, blocked, nodes));
  const report = planReportSchema.parse({
    outcome: 'passed',
    summary: 'All requirements checked.',
    checks: [{ criterion: 0, outcome: 'passed', evidence }],
    requirements: [{ key: 'triage', outcome: 'passed', evidence }],
  });
  assert.throws(() => validatePlanReport(nodes[1], plan.planning, report, nodes), /planning-verification/);
  const complete = nodes.map(node => (node.key === 'agent' ? { ...node, state: 'completed' } : node));
  assert.doesNotThrow(() => validatePlanReport(complete[1], plan.planning, report, complete));
  assert.throws(
    () => validatePlanReport(complete[1], plan.planning, { ...report, requirements: [] }, complete),
    /planning-evidence/,
  );
  assert.throws(
    () =>
      validatePlanReport(
        complete[1],
        plan.planning,
        report,
        complete.map(node => ({ ...node, state: 'cancelled' })),
      ),
    /planning-verification/,
  );
});

test('legacy plans remain valid without claiming structured verification', () => {
  const legacy = createPlanSchema.parse({ title: 'Existing plan', tasks: [{ key: 'read', title: 'Read' }] });
  assert.equal(legacy.planning, undefined);
  assert.equal(buildInitialPlan(legacy).nodes.length, 1);
});

test('report and prerequisite evidence are bounded before reaching database JSON limits', () => {
  const oversized = Array.from({ length: 100 }, (_, index) => ({
    key: `requirement-${index}`,
    outcome: 'passed',
    evidence: Array.from({ length: 16 }, () => ({ ...evidence[0], summary: 'x'.repeat(600) })),
  }));
  assert.throws(
    () => planReportSchema.parse({ outcome: 'passed', summary: 'Checked', checks: [], requirements: oversized }),
    /128 KiB/,
  );
  const plan = input();
  assert.throws(
    () =>
      createPlanSchema.parse({
        ...plan,
        planning: {
          ...plan.planning,
          prerequisites: oversized.map(check => ({
            key: check.key,
            title: 'Check access',
            tasks: ['agent'],
            status: 'verified',
            evidence: check.evidence,
          })),
        },
      }),
    /256 KiB/,
  );
});

test('workers report blocked checks explicitly and cannot omit criteria from a passed report', () => {
  assert.throws(() => parsePlanWorkerReport('I checked everything.', 1), /model-invalid-decision/);
  assert.throws(
    () => parsePlanWorkerReport(JSON.stringify({ outcome: 'passed', summary: 'Done', checks: [] }), 1),
    /model-invalid-decision/,
  );
  const blocked = {
    outcome: 'blocked',
    summary: 'The table ID is missing.',
    checks: [{ criterion: 0, outcome: 'unknown', summary: 'No table was read.' }],
  };
  assert.deepEqual(parsePlanWorkerReport(JSON.stringify(blocked), 1), blocked);
  assert.throws(
    () => parsePlanWorkerReport(JSON.stringify({ ...blocked, outcome: 'passed' }), 1),
    /model-invalid-decision/,
  );
});

test('an optional prerequisite that is not verified warns without blocking its tasks', () => {
  const plan = input();
  const optional = {
    ...plan.planning.prerequisites[0],
    status: 'blocked',
    evidence: [],
    reason: 'No channel yet; the agent can start with an empty channel list.',
    optional: true,
  };
  const planning = { ...plan.planning, prerequisites: [optional] };
  const built = buildInitialPlan({ ...plan, planning });
  assert.equal(built.nodes[0].state, 'ready');
  assert.equal(built.nodes[0].reason ?? null, null);
  assert.equal(createPlanSchema.parse({ ...plan, planning }).planning.prerequisites[0].optional, true);
  assert.equal(input().planning.prerequisites[0].optional, undefined);
  const done = built.nodes.map(node => ({ ...node, state: 'completed' }));
  assert.equal(summarizePlan(done, planning).outcome, 'completed');
});

test('a required prerequisite cannot later be relaxed to optional', () => {
  const plan = input();
  const { nodes } = buildInitialPlan(plan);
  const relaxed = { ...plan.planning, prerequisites: [{ ...plan.planning.prerequisites[0], optional: true }] };
  assert.throws(() => validatePlanning(nodes, relaxed, plan.planning), /planning-prerequisite/);
  assert.doesNotThrow(() => validatePlanning(nodes, relaxed, relaxed));
});
