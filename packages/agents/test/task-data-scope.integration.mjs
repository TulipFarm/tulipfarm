import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../tables/test/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createSavedAgentService } from '../src/saved-service.ts';
import { createAgentStore } from '../src/store.ts';
import { createAgentRecordTools } from '../src/record-tools.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { syntheticContinuity } from './continuity-fixture.mjs';
import { savedTaskAgent, seedExecution } from './task-fixture.mjs';
import { createWorkflows } from '../../workflows/src/service.ts';
import { activate as activateWorkflow } from '../../workflows/test/commands.fixture.mjs';

async function environment(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const user = randomUUID(),
    member = randomUUID(),
    table = name => `"${w.names.schema}".${name}`;
  await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
    member,
    user,
  ]);
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['tables.list', 'rows.list']);
  const field = textField();
  const customers = await createTableWithRows({
    db,
    workspace: w,
    runtime,
    definition: tableDefinition({ owningTeamId: agent.teamId, label: 'Customers', fields: [field] }),
    records: [{ values: textValues(field, 'Alice') }],
  });
  const scope = [{ assetId: customers.tableId, permissions: ['table.row.read'] }];
  await db.platform.query(
    `INSERT INTO ${table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
    [agent.teamId, customers.tableId],
  );
  await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
    agent.activationId,
    JSON.stringify(scope),
  ]);
  await db.platform.query(
    `UPDATE ${table('tf_agent_saved_revisions')} SET projection=jsonb_build_object('workspaceId',$2::text,'commit',soul_revision,'kind','agent','id',agent_id,'path','agent.json','bucket','fixture','key','fixture','sha256',definition_revision) WHERE agent_id=$1`,
    [agent.agentId, w.id],
  );
  const saved = createSavedAgentService(runtime, async () => ({
    formatVersion: 1,
    id: agent.agentId,
    name: 'Private assistant',
    instructions: 'Count rows.',
    tools: ['tables.list', 'rows.list'],
  }));
  const tasks = createAgentTasks(runtime);
  const value = () => ({ requestId: randomUUID(), agentId: agent.agentId, text: 'Count the customer rows.' });
  return { db, w, runtime, user, member, table, agent, customers, scope, saved, tasks, value };
}

test('replacement preserves each activation scope and a workflow pin stays narrow', { timeout: 60000 }, async t => {
  const f = await environment(t);
  const broad = [{ ...f.scope[0], permissions: ['table.row.read', 'table.row.update'] }];
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.update')`,
    [f.agent.teamId, f.customers.tableId],
  );
  await seedExecution(f.db, f.w, f.agent.agentId, [f.agent.teamId], broad);
  const store = createAgentStore(f.runtime);
  const latest = await f.agent.activate();
  await f.db.platform.query(
    `UPDATE ${f.table('tf_agent_saved_revisions')} SET projection=jsonb_build_object('workspaceId',$2::text,'commit',soul_revision,'kind','agent','id',agent_id,'path','agent.json','bucket','fixture','key','fixture','sha256',definition_revision) WHERE agent_id=$1`,
    [f.agent.agentId, f.w.id],
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
    latest.activationId,
    JSON.stringify(broad),
  ]);
  const originalTask = await f.tasks.start(f.w.id, f.user, {
    ...f.value(),
    activationId: f.agent.activationId,
  });
  const workflow = createWorkflows(f.runtime, { agentTasks: f.tasks });
  const workflowId = randomUUID(),
    revision = randomUUID();
  const limits = { toolCalls: 12, activeMilliseconds: 6000, credits: 4 };
  await workflow.save(f.w.id, f.user, workflowId, {
    revision,
    expectedRevision: null,
    definition: {
      version: 1,
      name: 'Read customers',
      triggers: [],
      steps: [
        {
          id: 'read',
          kind: 'agent',
          agentId: f.agent.agentId,
          activationId: f.agent.activationId,
          prompt: { kind: 'literal', value: 'Read the customer list.' },
          limits,
        },
      ],
    },
  });
  await activateWorkflow(workflow, f.w.id, f.user, workflowId, revision, true);
  const policy = (
    await f.db.platform.query(`SELECT saved_revision,policy_version FROM ${f.table('tf_agents')} WHERE id=$1`, [
      f.agent.agentId,
    ])
  ).rows[0];
  const actor = { kind: 'human', userId: f.w.userId, membershipId: f.w.membershipId };
  const request = {
    agentId: f.agent.agentId,
    requestId: randomUUID(),
    revision: latest.revision,
    scope: broad,
    expectedSavedRevision: policy.saved_revision,
    expectedPolicyVersion: policy.policy_version,
    expectedActivationIds: [f.agent.activationId, latest.activationId],
  };
  await store.replaceActivation(f.w.id, actor, request);
  assert.deepEqual(await store.replaceActivation(f.w.id, actor, request), { activationId: request.requestId });
  const pairs = (
    await f.db.platform.query(
      `SELECT a.id,a.scope,b.id AS replacement,b.scope AS replacement_scope,b.definition_revision,b.revoked_at
    FROM ${f.table('tf_agent_activations')} a JOIN ${f.table('tf_agent_activations')} b ON b.id=a.superseded_by_activation_id
    WHERE a.id=ANY($1::uuid[])`,
      [request.expectedActivationIds],
    )
  ).rows;
  assert.equal(pairs.length, 2);
  assert.equal(new Set(pairs.map(pair => pair.replacement)).size, 2);
  for (const pair of pairs) {
    assert.deepEqual(pair.replacement_scope, pair.scope);
    assert.equal(pair.definition_revision, latest.revision);
    assert.equal(pair.revoked_at, null);
  }
  const run = await workflow.start(f.w.id, f.user, workflowId, { requestId: randomUUID(), input: {} });
  assert.equal((await workflow.advance({ workspaceId: f.w.id, runId: run.runId })).kind, 'wait');
  const taskId = (await workflow.history(f.w.id, f.user, workflowId)).runs[0].steps[0].output.taskId;
  const task = await f.tasks.read(f.w.id, f.user, taskId);
  assert.equal(task.activationId, pairs.find(pair => pair.id === f.agent.activationId).replacement);
  assert.deepEqual(task.scope, f.scope);
  assert.deepEqual(task.limits, limits);
  assert.equal(task.definitionRevision, latest.revision);
  assert.deepEqual(
    (await f.db.platform.query(`SELECT scope FROM ${f.table('tf_agent_limits')} WHERE agent_id=$1`, [f.agent.agentId]))
      .rows[0].scope,
    broad,
  );
  const detail = await f.saved.detail(f.w.id, f.user, f.agent.agentId);
  assert.equal(detail.activations.length, 2);
  assert.ok(detail.replacedActivations.some(activation => activation.id === f.agent.activationId));
  assert.equal((await f.tasks.read(f.w.id, f.user, originalTask.id)).activationId, f.agent.activationId);
  await store.revokeActivation(f.w.id, actor, { agentId: f.agent.agentId, activationId: f.agent.activationId });
  assert.ok(
    !(await f.saved.detail(f.w.id, f.user, f.agent.agentId)).replacedActivations.some(
      activation => activation.id === f.agent.activationId,
    ),
  );
});

test('default manual and workflow tasks list and read the same table as their run form', async t => {
  const f = await environment(t);
  await seedExecution(f.db, f.w, f.agent.agentId, [f.agent.teamId], f.scope);
  const preview = (await f.saved.detail(f.w.id, f.user, f.agent.agentId)).activations[0];
  assert.deepEqual(preview.effectiveScope, f.scope);
  const store = createAgentStore(f.runtime),
    tools = createAgentRecordTools(f.runtime);
  for (const start of [f.tasks.start, f.tasks.startForWorkflow]) {
    const receipt = await start(f.w.id, f.user, f.value());
    const task = await f.tasks.read(f.w.id, f.user, receipt.id);
    assert.deepEqual(task.scope, preview.effectiveScope);
    const run = await store.startTaskRun(
      f.w.id,
      { kind: 'human', userId: f.user, membershipId: f.member },
      { activationId: task.activationId, scope: task.scope },
      { id: task.id, generation: task.generation },
    );
    const actor = { kind: 'agent', runId: run.runId };
    const listed = await tools.list(f.w.id, actor);
    assert.deepEqual(
      listed.tables.map(table => table.name),
      ['Customers'],
    );
    const rows = await tools.listRecords(f.w.id, actor, f.customers.tableId, f.customers.revision, {});
    assert.equal(rows.records.length, 1);
  }
  const model = syntheticContinuity(async input => {
    const { results } = JSON.parse(input.prompt);
    if (!results.length) return { kind: 'tool', text: 'Find the customer table.', call: { tool: 'tables.list' } };
    const listed = results.find(item => item.call.tool === 'tables.list');
    assert.deepEqual(
      listed.result.tables.map(table => table.name),
      ['Customers'],
    );
    if (!results.some(item => item.call.tool === 'rows.list'))
      return {
        kind: 'tool',
        text: 'Read the customer rows.',
        call: {
          tool: 'rows.list',
          tableId: listed.result.tables[0].id,
          expectedAppliedRevision: listed.result.tables[0].appliedRevision,
          query: {},
        },
      };
    const rows = results.find(item => item.call.tool === 'rows.list');
    assert.equal(rows.result.records.length, 1);
    return { kind: 'answer', text: 'Customers has 1 row.' };
  });
  const engine = createTaskRuntime(f.runtime, model);
  for (const start of [f.tasks.start, f.tasks.startForWorkflow]) {
    const task = await start(f.w.id, f.user, f.value());
    for (let step = 0; step < 8 && (await f.tasks.read(f.w.id, f.user, task.id)).status === 'pending'; step++)
      await engine.process(f.w.id, task.id);
    assert.equal((await f.tasks.read(f.w.id, f.user, task.id)).status, 'completed');
    assert.equal((await f.tasks.history(f.w.id, f.user, task.id)).messages.at(-1).text, 'Customers has 1 row.');
  }
});

test('unreachable selected tables are disclosed and stop manual and workflow tasks without adding enrollment', async t => {
  const f = await environment(t);
  await seedExecution(f.db, f.w, f.agent.agentId, [], f.scope);
  const preview = (await f.saved.detail(f.w.id, f.user, f.agent.agentId)).activations[0];
  assert.deepEqual(preview.scope, f.scope);
  assert.deepEqual(preview.effectiveScope, []);
  for (const start of [f.tasks.start, f.tasks.startForWorkflow]) {
    const task = await start(f.w.id, f.user, { ...f.value(), scope: f.scope });
    assert.equal(task.status, 'failed');
    assert.equal((await f.tasks.read(f.w.id, f.user, task.id)).failureReason, 'authority-revoked');
    const history = await f.tasks.history(f.w.id, f.user, task.id);
    assert.match(history.messages.at(-1).text, /couldn't reach Customers/);
    assert.match(history.messages.at(-1).text, /Change teams used for access/);
  }
  assert.equal(
    (await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_agent_teams')} WHERE agent_id=$1`, [f.agent.agentId]))
      .rowCount,
    0,
  );
});

test('invocation scope and current limits narrow the run form without granting extra access', async t => {
  const f = await environment(t);
  await seedExecution(f.db, f.w, f.agent.agentId, [f.agent.teamId], f.scope);
  const empty = await f.tasks.start(f.w.id, f.user, { ...f.value(), scope: [] });
  assert.deepEqual((await f.tasks.read(f.w.id, f.user, empty.id)).scope, []);
  assert.equal(empty.status, 'pending');
  await seedExecution(f.db, f.w, f.agent.agentId, [f.agent.teamId], []);
  assert.deepEqual((await f.saved.detail(f.w.id, f.user, f.agent.agentId)).activations[0].effectiveScope, []);
  const narrowed = await f.tasks.start(f.w.id, f.user, f.value());
  assert.equal(narrowed.status, 'failed');
});

test('missing write permissions fail tasks even when the selected table remains readable', async t => {
  const f = await environment(t);
  for (const permissions of [['table.row.update'], ['table.row.read', 'table.row.update']]) {
    const scope = [{ assetId: f.customers.tableId, permissions }];
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
      f.agent.activationId,
      JSON.stringify(scope),
    ]);
    await seedExecution(f.db, f.w, f.agent.agentId, [f.agent.teamId], scope);
    for (const start of [f.tasks.start, f.tasks.startForWorkflow]) {
      const task = await start(f.w.id, f.user, f.value());
      assert.equal(task.status, 'failed');
      assert.match((await f.tasks.history(f.w.id, f.user, task.id)).messages.at(-1).text, /couldn't reach Customers/);
    }
  }
});

test('a task cannot complete after table access is removed before processing or before its answer', async t => {
  const f = await environment(t);
  for (const beforeProcessing of [true, false]) {
    await seedExecution(f.db, f.w, f.agent.agentId, [f.agent.teamId], f.scope);
    const task = await f.tasks.start(f.w.id, f.user, f.value());
    const revoke = () =>
      f.db.platform.query(`DELETE FROM ${f.table('tf_agent_teams')} WHERE agent_id=$1`, [f.agent.agentId]);
    if (beforeProcessing) await revoke();
    let calls = 0;
    const model = syntheticContinuity(async () => {
      calls++;
      await revoke();
      return { kind: 'answer', text: 'No tables found.' };
    });
    await createTaskRuntime(f.runtime, model).process(f.w.id, task.id);
    assert.equal((await f.tasks.read(f.w.id, f.user, task.id)).status, 'failed');
    assert.equal(calls, beforeProcessing ? 0 : 1);
    assert.match((await f.tasks.history(f.w.id, f.user, task.id)).messages.at(-1).text, /couldn't reach Customers/);
  }
});
