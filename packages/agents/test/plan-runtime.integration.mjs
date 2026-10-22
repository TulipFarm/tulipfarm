import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentPlans } from '../src/plans.ts';
import { createPlanRuntime } from '../src/plan-runtime.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { registerExtension } from '@tulipfarm/extensions';
import { hostedCreditPricingExtension } from '../../workspace-storage/test/hosted-credit-pricing.mjs';

// Budget and balance assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

const states = view => Object.fromEntries(view.tasks.map(task => [task.key, task.state]));
const specialist = {
  key: 'researcher',
  name: 'Researcher',
  role: 'Finds facts',
  instructions: 'Research the task.',
  tools: ['web.search'],
};
const work = (key, extra = {}) => ({
  key,
  title: key.toUpperCase(),
  assignee: { kind: 'specialist', specialist: 'researcher' },
  ...extra,
});

async function setup(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const starter = randomUUID(),
    starterMember = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    starterMember,
    starter,
  ]);
  const chat = async () => {
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
      [id, starter, starterMember],
    );
    return id;
  };
  const plans = createAgentPlans(runtime);
  const create = async (outline, budget) =>
    plans.create(w.id, starter, await chat(), randomUUID(), {
      specialists: [specialist],
      ...outline,
      ...(budget ? { budget } : {}),
    });
  const attempts = async planId =>
    (
      await db.platform.query(
        `SELECT id, task_key AS key, generation, status, failure_code AS failure, allowance, agent_task_id AS "agentTaskId" FROM ${table('tf_agent_plan_attempts')} WHERE plan_id=$1 ORDER BY created_at, id`,
        [planId],
      )
    ).rows;
  const lifecycle = async planId =>
    (await db.platform.query(`SELECT lifecycle FROM ${table('tf_agent_plans')} WHERE id=$1`, [planId])).rows[0]
      .lifecycle;
  const events = async planId =>
    (
      await db.platform.query(
        `SELECT changes FROM ${table('tf_agent_plan_events')} WHERE plan_id=$1 ORDER BY version`,
        [planId],
      )
    ).rows.flatMap(row => row.changes);
  return {
    db,
    w,
    runtime,
    table,
    starter,
    starterMember,
    plans,
    create,
    attempts,
    lifecycle,
    events,
    read: id => plans.read(w.id, starter, id),
  };
}

test(
  'plans run at most three workers, share one budget, pass results to dependents and retry lost workers',
  { timeout: 120000 },
  async t => {
    const { w, runtime, db, table, create, attempts, read, lifecycle } = await setup(t);
    const scheduler = createPlanRuntime(runtime);
    const plan = await create(
      { title: 'Research', tasks: [work('a'), work('b'), work('c'), work('d'), work('e', { dependsOn: ['a'] })] },
      { toolCalls: 30, activeMilliseconds: 600000, credits: 9 },
    );

    const first = await scheduler.step(w.id, plan.id);
    assert.equal(first.kind, 'waiting');
    assert.equal(first.specialists.length, 3);
    let rows = await attempts(plan.id);
    assert.deepEqual(
      rows.map(row => row.key),
      ['a', 'b', 'c'],
    );
    for (const row of rows) assert.deepEqual(row.allowance, { toolCalls: 10, activeMilliseconds: 200000, credits: 3 });
    assert.deepEqual(states(await read(plan.id)), {
      a: 'running',
      b: 'running',
      c: 'running',
      d: 'ready',
      e: 'pending',
    });
    assert.deepEqual((await scheduler.step(w.id, plan.id)).specialists, [], 'three running workers fill every slot');

    const [a, b, c] = first.specialists;
    const assignment = await scheduler.claimSpecialist(w.id, a);
    assert.equal(assignment.title, 'A');
    assert.deepEqual(assignment.tools, ['web.search']);
    assert.equal(assignment.instructions, 'Research the task.');
    assert.equal(
      await scheduler.admitSpecialistStep(w.id, a, 20_000_000_001n, async () => true),
      false,
      'rounding this provider cost needs four credits, above the allowance',
    );
    let reserved = false;
    assert.equal(
      await scheduler.admitSpecialistStep(w.id, a, 20_000_000_000n, async () => {
        reserved = true;
        return true;
      }),
      true,
      'this provider cost reserves exactly three credits',
    );
    assert.equal(reserved, true);

    assert.equal(
      await scheduler.settleSpecialist(
        w.id,
        a,
        { kind: 'completed', result: 'A found two vendors.', sources: [] },
        { toolCalls: 2, activeMilliseconds: 1000 },
      ),
      true,
    );
    assert.equal(
      await scheduler.settleSpecialist(
        w.id,
        a,
        { kind: 'failed', code: 'late' },
        { toolCalls: 0, activeMilliseconds: 0 },
      ),
      false,
      'a settled attempt cannot be rewritten',
    );
    assert.equal(await scheduler.claimSpecialist(w.id, a), null);
    const second = await scheduler.step(w.id, plan.id);
    assert.equal(second.specialists.length, 1, 'one freed slot admits one worker');
    assert.deepEqual(states(await read(plan.id)), {
      a: 'completed',
      b: 'running',
      c: 'running',
      d: 'running',
      e: 'ready',
    });

    for (const id of [b, c, ...second.specialists])
      await scheduler.settleSpecialist(
        w.id,
        id,
        { kind: 'completed', result: 'done', sources: [] },
        { toolCalls: 1, activeMilliseconds: 100 },
      );
    const third = await scheduler.step(w.id, plan.id);
    assert.equal(third.specialists.length, 1);
    assert.deepEqual((await scheduler.claimSpecialist(w.id, third.specialists[0])).inputs, [
      { title: 'A', result: 'A found two vendors.' },
    ]);

    await db.platform.query(
      `UPDATE ${table('tf_agent_plan_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [third.specialists[0]],
    );
    assert.equal(
      await scheduler.claimSpecialist(w.id, third.specialists[0]),
      null,
      'an expired lease cannot be claimed',
    );
    const retried = await scheduler.step(w.id, plan.id);
    assert.equal(retried.specialists.length, 1);
    assert.notEqual(retried.specialists[0], third.specialists[0]);
    assert.equal(
      await scheduler.settleSpecialist(
        w.id,
        third.specialists[0],
        { kind: 'completed', result: 'stale', sources: [] },
        { toolCalls: 0, activeMilliseconds: 0 },
      ),
      false,
      'a replaced attempt cannot settle',
    );
    rows = (await attempts(plan.id)).filter(row => row.key === 'e');
    assert.deepEqual(
      rows.map(row => [row.generation, row.status, row.failure]),
      [
        [0, 'failed', 'lease-expired'],
        [1, 'running', null],
      ],
    );

    await scheduler.settleSpecialist(
      w.id,
      retried.specialists[0],
      { kind: 'failed', code: 'specialist-failed' },
      { toolCalls: 0, activeMilliseconds: 10 },
    );
    const last = await scheduler.step(w.id, plan.id);
    await scheduler.settleSpecialist(
      w.id,
      last.specialists[0],
      { kind: 'failed', code: 'specialist-failed' },
      { toolCalls: 0, activeMilliseconds: 10 },
    );
    const view = await read(plan.id);
    assert.equal(states(view).e, 'failed');
    assert.match(view.tasks.find(task => task.key === 'e').reason, /3 attempts/);
    assert.equal((await scheduler.step(w.id, plan.id)).kind, 'terminal');
    assert.equal(await lifecycle(plan.id), 'failed');
  },
);

test('recovery closes a failed plan only after independent work finishes', { timeout: 60000 }, async t => {
  const { w, runtime, starter, plans, create, attempts, read, lifecycle, events } = await setup(t);
  const scheduler = createPlanRuntime(runtime);
  const plan = await create({
    title: 'Alert triage',
    tasks: [work('capabilities'), work('records'), work('review', { dependsOn: ['capabilities', 'records'] })],
  });
  const [capabilities, records] = (await scheduler.step(w.id, plan.id)).specialists;
  let attempt = capabilities;
  for (let failure = 0; failure < 3; failure += 1) {
    await scheduler.settleSpecialist(
      w.id,
      attempt,
      { kind: 'failed', code: 'specialist-failed' },
      { toolCalls: 0, activeMilliseconds: 10 },
    );
    const progress = await scheduler.step(w.id, plan.id);
    assert.equal(progress.kind, 'waiting', 'independent work continues after a failed branch');
    if (failure < 2) [attempt] = progress.specialists;
    else assert.deepEqual(progress.specialists, []);
  }
  assert.equal(await lifecycle(plan.id), 'active');
  assert.deepEqual(states(await read(plan.id)), { capabilities: 'failed', records: 'running', review: 'blocked' });

  await scheduler.settleSpecialist(
    w.id,
    records,
    { kind: 'completed', result: 'Records checked.', sources: [] },
    { toolCalls: 1, activeMilliseconds: 10 },
  );
  assert.ok(
    (await scheduler.due(w.id)).includes(plan.id),
    'recovery finds an existing active plan with no remaining work',
  );
  assert.deepEqual(await scheduler.step(w.id, plan.id), { kind: 'terminal', specialists: [] });
  const view = await read(plan.id);
  assert.equal(view.lifecycle, 'failed');
  assert.equal(view.outcome, 'failed');
  assert.deepEqual(states(view), { capabilities: 'failed', records: 'completed', review: 'blocked' });
  assert.equal(view.counts.running, 0);
  assert.ok((await attempts(plan.id)).every(row => row.status === 'failed' || row.status === 'completed'));
  assert.deepEqual(
    (await events(plan.id)).filter(change => change.op === 'lifecycle'),
    [{ op: 'lifecycle', to: 'failed' }],
  );
  assert.deepEqual(await scheduler.due(w.id), [], 'failed plans leave the recovery queue');

  await assert.rejects(
    plans.control(w.id, starter, plan.id, { requestId: randomUUID(), expectedVersion: view.version, action: 'resume' }),
    error => error.code === 'plan-closed',
  );
  assert.deepEqual(await scheduler.step(w.id, plan.id), { kind: 'terminal', specialists: [] });
  assert.equal((await read(plan.id)).version, view.version, 'repeated wakes do not change a terminal plan');
});

test(
  'plans complete, pause when the budget cannot fund work, and pause when the starter loses access',
  { timeout: 120000 },
  async t => {
    const { w, runtime, db, table, starterMember, create, lifecycle, events } = await setup(t);
    const scheduler = createPlanRuntime(runtime);

    const single = await create({ title: 'One step', tasks: [work('only')] });
    const [only] = (await scheduler.step(w.id, single.id)).specialists;
    await scheduler.settleSpecialist(
      w.id,
      only,
      { kind: 'completed', result: 'Finished.', sources: [] },
      { toolCalls: 1, activeMilliseconds: 10 },
    );
    assert.deepEqual(await scheduler.step(w.id, single.id), { kind: 'terminal', specialists: [] });
    assert.equal(await lifecycle(single.id), 'completed');

    const poor = await create(
      { title: 'Too small', tasks: [work('x'), work('y')] },
      { toolCalls: 30, activeMilliseconds: 600000, credits: 1 },
    );
    assert.deepEqual(await scheduler.step(w.id, poor.id), { kind: 'terminal', specialists: [] });
    assert.equal(await lifecycle(poor.id), 'paused');
    assert.ok((await events(poor.id)).some(change => change.op === 'lifecycle' && change.reason === 'budget'));

    const orphan = await create({ title: 'Orphaned', tasks: [work('z')] });
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      starterMember,
    ]);
    assert.deepEqual(await scheduler.step(w.id, orphan.id), { kind: 'terminal', specialists: [] });
    assert.equal(await lifecycle(orphan.id), 'paused');
    assert.ok(
      (await events(orphan.id)).some(change => change.op === 'lifecycle' && change.reason === 'starter-access'),
    );
    assert.deepEqual(await scheduler.due(w.id), []);
  },
);

test(
  'saved agents start once per attempt as the starter and fail or block when access is revoked',
  { timeout: 120000 },
  async t => {
    const { w, runtime, db, table, starter, starterMember, plans, create, attempts, read } = await setup(t);
    const agent = await savedTaskAgent(db, w, runtime, starter, starterMember, [], ['rows.list']);
    const assign = async (plan, key) =>
      plans.update(w.id, starter, plan.id, randomUUID(), {
        expectedVersion: 0,
        mutations: [{ op: 'assign', key, assignee: { kind: 'agent', agentId: agent.agentId } }],
      });
    const plan = await create({ title: 'Delegate', tasks: [{ key: 'kept', title: 'Kept', criteria: ['Answered'] }] });
    const later = await create({ title: 'Later', tasks: [{ key: 'later', title: 'Later' }] });
    await assign(plan, 'kept');
    await assign(later, 'later');

    const woken = [];
    const wake = async (_workspace, taskId) => {
      woken.push(taskId);
    };
    const scheduler = createPlanRuntime(runtime, createAgentTasks(runtime));
    assert.deepEqual(await scheduler.step(w.id, plan.id, wake), { kind: 'waiting', specialists: [] });
    assert.deepEqual(states(await read(plan.id)), { kept: 'running' });
    const [attempt] = await attempts(plan.id);
    assert.deepEqual(woken, [attempt.agentTaskId]);
    const task = (
      await db.platform.query(
        `SELECT agent_id, owner_membership_id AS membership_id FROM ${table('tf_agent_tasks')} WHERE id=$1`,
        [attempt.agentTaskId],
      )
    ).rows[0];
    assert.deepEqual(task, { agent_id: agent.agentId, membership_id: starterMember });
    assert.deepEqual(await scheduler.step(w.id, plan.id, wake), { kind: 'waiting', specialists: [] });
    assert.equal(woken.length, 1, 'a running saved task is observed, not started again');

    await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE team_id=$1`, [agent.teamId]);
    assert.equal((await scheduler.step(w.id, plan.id, wake)).kind, 'terminal');
    assert.equal(states(await read(plan.id)).kept, 'failed');
    assert.equal((await attempts(plan.id))[0].failure, 'access-revoked');

    assert.equal((await scheduler.step(w.id, later.id, wake)).kind, 'terminal');
    const view = await read(later.id);
    assert.equal(states(view).later, 'blocked');
    assert.match(view.tasks.find(item => item.key === 'later').reason, /can no longer use this saved agent/);
    assert.deepEqual(await attempts(later.id), []);
  },
);

test(
  'starters pause, resume and stop plans; pauses spare retries and stops cancel saved tasks',
  { timeout: 120000 },
  async t => {
    const { w, runtime, db, table, starter, starterMember, plans, create, attempts, read, lifecycle } = await setup(t);
    const notified = [];
    db.platform.on('notification', message => {
      if (message.channel === 'tf_conversation_events') notified.push(JSON.parse(message.payload));
    });
    await db.platform.query('LISTEN tf_conversation_events');
    const planError = code => error => error.code === code;
    const scheduler = createPlanRuntime(runtime, createAgentTasks(runtime));
    const agent = await savedTaskAgent(db, w, runtime, starter, starterMember, [], ['rows.list']);
    const plan = await create({
      title: 'Controlled',
      tasks: [work('a'), { key: 'ask', title: 'Ask' }, work('after', { dependsOn: ['a'] })],
    });
    await plans.update(w.id, starter, plan.id, randomUUID(), {
      expectedVersion: 0,
      mutations: [{ op: 'assign', key: 'ask', assignee: { kind: 'agent', agentId: agent.agentId } }],
    });
    const control = (input, requestId = randomUUID()) => plans.control(w.id, starter, plan.id, { requestId, ...input });

    const [first] = (await scheduler.step(w.id, plan.id, async () => {})).specialists;
    const saved = (await attempts(plan.id)).find(row => row.key === 'ask');
    await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='waiting-clarification' WHERE id=$1`, [
      saved.agentTaskId,
    ]);
    await scheduler.step(w.id, plan.id, async () => {});
    let view = await read(plan.id);
    assert.equal(
      view.tasks.find(task => task.key === 'ask').waitingTaskId,
      saved.agentTaskId,
      'the starter can open the saved task that waits for an answer',
    );
    assert.equal(view.tasks.find(task => task.key === 'a').waitingTaskId, null);

    await assert.rejects(
      control({ action: 'pause', expectedVersion: view.version - 1 }),
      planError('version-conflict'),
    );
    const pauseId = randomUUID();
    const paused = await control({ action: 'pause', expectedVersion: view.version }, pauseId);
    assert.deepEqual(
      await control({ action: 'pause', expectedVersion: view.version }, pauseId),
      paused,
      'a replayed control returns its receipt',
    );
    view = await read(plan.id);
    assert.equal(view.lifecycle, 'paused');
    assert.equal(view.pause, 'starter');
    assert.equal(states(view).a, 'pending', 'a paused specialist starts again on resume');
    assert.equal(await scheduler.claimSpecialist(w.id, first), null);
    assert.equal(
      await scheduler.settleSpecialist(
        w.id,
        first,
        { kind: 'failed', code: 'step-not-admitted' },
        { toolCalls: 0, activeMilliseconds: 0 },
      ),
      false,
    );
    assert.deepEqual(
      (await scheduler.step(w.id, plan.id, async () => {})).specialists,
      [],
      'a paused plan starts nothing',
    );
    view = await read(plan.id);

    await assert.rejects(
      control({
        action: 'resume',
        expectedVersion: view.version,
        budget: { toolCalls: 10, activeMilliseconds: 1800000, credits: 300 },
      }),
      planError('budget-lowered'),
    );
    await control({
      action: 'resume',
      expectedVersion: view.version,
      budget: { toolCalls: 400, activeMilliseconds: 1800000, credits: 300 },
    });
    view = await read(plan.id);
    assert.equal(view.lifecycle, 'active');
    assert.equal(view.pause, null);
    assert.equal(view.budget.toolCalls, 400);

    for (let failure = 0; failure < 2; failure += 1) {
      const [next] = (await scheduler.step(w.id, plan.id, async () => {})).specialists;
      await scheduler.settleSpecialist(
        w.id,
        next,
        { kind: 'failed', code: 'specialist-failed' },
        { toolCalls: 0, activeMilliseconds: 10 },
      );
    }
    assert.equal(states(await read(plan.id)).a, 'pending', 'a cancelled attempt does not count toward the three tries');
    await scheduler.step(w.id, plan.id, async () => {});

    view = await read(plan.id);
    await control({ action: 'stop', expectedVersion: view.version });
    view = await read(plan.id);
    assert.equal(view.lifecycle, 'stopped');
    assert.deepEqual(states(view), { a: 'cancelled', ask: 'cancelled', after: 'cancelled' });
    assert.ok((await attempts(plan.id)).every(row => row.status !== 'running' && row.status !== 'waiting-input'));
    assert.equal(
      (await db.platform.query(`SELECT status FROM ${table('tf_agent_tasks')} WHERE id=$1`, [saved.agentTaskId]))
        .rows[0].status,
      'paused',
    );
    assert.equal((await createAgentTasks(runtime).read(w.id, starter, saved.agentTaskId)).pauseReason, 'plan');
    assert.equal(await lifecycle(plan.id), 'stopped');
    await assert.rejects(control({ action: 'resume', expectedVersion: view.version }), planError('plan-closed'));
    await assert.rejects(
      plans.update(w.id, starter, plan.id, randomUUID(), {
        expectedVersion: view.version,
        mutations: [{ op: 'retry', key: 'a' }],
      }),
      planError('plan-closed'),
    );
    assert.deepEqual(await scheduler.step(w.id, plan.id, async () => {}), { kind: 'terminal', specialists: [] });
    const events = (
      await db.platform.query(
        `SELECT actor, kind FROM ${table('tf_agent_plan_events')} WHERE plan_id=$1 AND kind='controlled'`,
        [plan.id],
      )
    ).rows;
    assert.equal(events.length, 3);
    assert.ok(events.every(event => event.actor === 'starter'));

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(notified.filter(item => item.planId === plan.id).length >= 6, 'plan changes notify the chat');
    assert.ok(notified.every(item => item.kind === 'changed' && item.workspaceId === w.id));
  },
);

test('stop pauses or prevents a saved task whose start races the stop', { timeout: 120000 }, async t => {
  const { w, runtime, db, table, starter, starterMember, plans, create, attempts, read } = await setup(t);
  const agent = await savedTaskAgent(db, w, runtime, starter, starterMember, [], ['rows.list']);
  const tasks = createAgentTasks(runtime);
  const planned = async () => {
    const plan = await create({ title: 'Raced', tasks: [{ key: 'saved', title: 'Saved' }] });
    await plans.update(w.id, starter, plan.id, randomUUID(), {
      expectedVersion: 0,
      mutations: [{ op: 'assign', key: 'saved', assignee: { kind: 'agent', agentId: agent.agentId } }],
    });
    return plan;
  };
  const stop = async plan =>
    plans.control(w.id, starter, plan.id, {
      requestId: randomUUID(),
      action: 'stop',
      expectedVersion: (await read(plan.id)).version,
    });
  const task = async id =>
    (await db.platform.query(`SELECT status, pause_reason AS reason FROM ${table('tf_agent_tasks')} WHERE id=$1`, [id]))
      .rows[0];
  const woken = [];
  const wake = async (_workspace, taskId) => {
    woken.push(taskId);
  };

  const linked = await planned();
  let created;
  const stoppedBeforeLink = createPlanRuntime(runtime, {
    ...tasks,
    startForWorkflow: async (...args) => {
      created = await tasks.startForWorkflow(...args);
      await stop(linked);
      return created;
    },
  });
  await stoppedBeforeLink.step(w.id, linked.id, wake);
  assert.deepEqual(
    await task(created.id),
    { status: 'paused', reason: 'plan' },
    'stop between task creation and linkage',
  );
  assert.equal((await attempts(linked.id))[0].agentTaskId, created.id);
  assert.deepEqual(woken, []);

  const crashed = await planned();
  const lost = createPlanRuntime(runtime, {
    ...tasks,
    startForWorkflow: async (...args) => {
      created = await tasks.startForWorkflow(...args);
      throw new Error('worker lost');
    },
  });
  await assert.rejects(lost.step(w.id, crashed.id, wake), /worker lost/);
  await stop(crashed);
  assert.equal((await createPlanRuntime(runtime, tasks).step(w.id, crashed.id, wake)).kind, 'terminal');
  assert.deepEqual(
    await task(created.id),
    { status: 'paused', reason: 'plan' },
    'stop after the worker lost an unlinked task',
  );
  assert.deepEqual(woken, []);

  const late = await planned();
  const before = (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_agent_tasks')}`)).rows[0]
    .count;
  const stoppedBeforeStart = createPlanRuntime(runtime, {
    ...tasks,
    startForWorkflow: async (...args) => {
      await stop(late);
      return tasks.startForWorkflow(...args);
    },
  });
  await stoppedBeforeStart.step(w.id, late.id, wake);
  assert.equal(
    (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_agent_tasks')}`)).rows[0].count,
    before,
    'no task starts for a stopped attempt',
  );
  assert.equal((await attempts(late.id))[0].status, 'cancelled');
  assert.deepEqual(woken, []);
});
