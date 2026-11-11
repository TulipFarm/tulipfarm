import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { serializeAgentDocument } from '@tulipfarm/workspaces/agent-document';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentSetup } from '../src/setup.ts';
import { createAgentAuthoring } from '../src/authoring.ts';
import { createSavedAgentService } from '../src/saved-service.ts';
import { AgentError } from '../src/saved-contracts.ts';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createChatTools } from '../src/tools.ts';
import { agentLinkedDefinition, agentLinkedWorkflowId } from '../src/agent-trigger-workflows.ts';
import { agentWorkflowTriggerId, tableAccessEnrollment } from '../src/setup-contracts.ts';
import { createWorkflows } from '@tulipfarm/workflows';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../tables/test/fixture.mjs';
import { builderDraft, parseBuilder } from '../../../apps/web/src/features/agents/builder-draft.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { syntheticContinuity } from './continuity-fixture.mjs';
import { nativeChatTools } from '../src/native-tools.ts';
import { use } from './native-fixture.mjs';

const limits = { toolCalls: 10, activeMilliseconds: 60000, credits: 10 };
async function environment(t) {
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
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const member = randomUUID(),
    user = randomUUID(),
    agentId = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
  const head = async () =>
    (await db.platform.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0].revision;
  let writes = 0;
  const worker = createAgentAuthoring(runtime).withWriter(async input => {
    writes++;
    const commit = createHash('sha1').update(input.commandId).digest('hex');
    return {
      parentCommit: input.expectedParentCommit,
      commit,
      bundle: { key: `bundle-${commit}`, sha256: 'b'.repeat(64) },
      projection: {
        workspaceId: w.id,
        commit,
        kind: 'agent',
        id: input.definition.id,
        path: `agents/${input.definition.id}.json`,
        bucket: 'synthetic',
        key: `projection-${commit}`,
        sha256: createHash('sha256').update(serializeAgentDocument(input.definition)).digest('hex'),
      },
    };
  });
  const setup = () => ({
    definition: { name: 'Setup helper', instructions: 'Follow reviewed tasks.', tools: [] },
    owningTeamId: null,
    policy: {
      grants: [],
      personGrants: [{ membershipId: member, permissions: ['read', 'edit', 'manage', 'invoke', 'delete'] }],
    },
    enrollment: [],
    scope: [],
    limits: [],
    taskLimits: limits,
    slackSender: 'user',
    slackChannels: [],
    triggers: [],
  });
  const input = async (overrides = {}) => ({
    requestId: randomUUID(),
    expectedVersion: 0,
    expectedSoulRevision: await head(),
    expectedSavedRevision: null,
    expectedPolicyVersion: 0,
    expectedActivationIds: [],
    expectedWorkflowRevision: null,
    expectedWorkflowGeneration: null,
    setup: setup(),
    ...overrides,
  });
  const decision = (draft, choice = 'activate') => ({
    requestId: randomUUID(),
    version: draft.version,
    digest: draft.digest,
    decision: choice,
    consent: {
      replaceChannels: draft.setup.slackChannels
        .filter(channel => channel.replaceAgentId)
        .map(channel => channel.channel),
    },
  });
  async function accept(service, command) {
    const definition = await service.definitionCommand(w.id, user, command.commandId);
    assert.equal((await worker.prepare(w.id, definition.commandId)).status, 'accepted');
  }
  const state = async () => ({
    agent: (
      await db.platform.query(`SELECT enabled,saved_revision,policy_version FROM ${table('tf_agents')} WHERE id=$1`, [
        agentId,
      ])
    ).rows[0],
    activations: (
      await db.platform.query(
        `SELECT id FROM ${table('tf_agent_activations')} WHERE agent_id=$1 AND revoked_at IS NULL ORDER BY id`,
        [agentId],
      )
    ).rows.map(row => row.id),
    workflows: (
      await db.platform.query(
        `SELECT w.id,w.enabled,w.sponsor_membership_id,w.archived_at,w.archived_with_agent,r.definition FROM ${table('tf_workflows')} w JOIN ${table('tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.revision WHERE w.agent_id=$1 ORDER BY w.id`,
        [agentId],
      )
    ).rows,
  });
  return {
    db,
    runtime,
    w,
    table,
    member,
    user,
    agentId,
    setup,
    input,
    decision,
    accept,
    state,
    head,
    worker,
    writes: () => writes,
  };
}

test('table enrollment requires current author membership and grants at save and activation', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime),
    teamId = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Operations')`, [teamId]);
  const { tableId } = await createTableWithRows({
    db: f.db,
    workspace: f.w,
    runtime: f.runtime,
    definition: tableDefinition({ owningTeamId: teamId, label: 'Customers' }),
  });
  const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
  const setup = { ...f.setup(), enrollment: [teamId], scope, limits: scope };
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
    [teamId, tableId],
  );
  assert.deepEqual((await createSavedAgentService(f.runtime).context(f.w.id, f.user)).teams, []);
  await assert.rejects(
    service.saveDraft(f.w.id, f.user, f.agentId, await f.input({ setup })),
    error => error.code === 'agent-team-assignment-required',
    'a granting team the author does not belong to cannot be enrolled',
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id,role) VALUES($1,$2,'manager')`,
    [f.member, teamId],
  );
  const context = await createSavedAgentService(f.runtime).context(f.w.id, f.user);
  assert.deepEqual(context.teams[0].tableScope, scope);
  await assert.rejects(
    service.saveDraft(f.w.id, f.user, f.agentId, await f.input({ setup: { ...setup, enrollment: [] } })),
    error => error.code === 'agent-table-access-unavailable',
  );
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input({ setup }));
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE team_id=$1`, [teamId]);
  await assert.rejects(
    service.advance(f.w.id, f.user, command.commandId),
    error => error.code === 'agent-table-access-unavailable',
    'grant revocation after draft save is rechecked before activation',
  );
  assert.deepEqual((await f.state()).activations, []);
  assert.equal((await service.readDraft(f.w.id, f.user, f.agentId)).setup.enrollment[0], teamId);
});

async function tableSetup(f, role = 'manager') {
  const teamId = randomUUID(),
    field = textField();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Operations')`, [teamId]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id,role) VALUES($1,$2,$3)`, [
    f.member,
    teamId,
    role,
  ]);
  const customers = await createTableWithRows({
    db: f.db,
    workspace: f.w,
    runtime: f.runtime,
    definition: tableDefinition({ owningTeamId: teamId, label: 'Customers', fields: [field] }),
    records: [{ values: textValues(field, 'Alice') }],
  });
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
    [teamId, customers.tableId],
  );
  const scope = [{ assetId: customers.tableId, permissions: ['table.row.read'] }];
  return {
    teamId,
    customers,
    scope,
    setup: {
      ...f.setup(),
      definition: {
        name: 'Customer reader',
        instructions: 'Count the customer rows.',
        tools: ['tables.list', 'rows.list'],
      },
      enrollment: [teamId],
      scope,
      limits: scope,
    },
  };
}

test('table enrollment blocks plain members in the builder and a manager can create, activate and read rows', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime),
    data = await tableSetup(f, 'member');
  const saved = createSavedAgentService(f.runtime);
  let context = await saved.context(f.w.id, f.user);
  assert.equal(context.teams[0].canAssign, false);
  const draft = builderDraft();
  draft.definition = data.setup.definition;
  draft.access.scope = data.scope;
  draft.access.limits = data.scope;
  draft.access.enrollment = tableAccessEnrollment(context.teams, data.scope[0], []);
  const blocked = parseBuilder(draft, f.member, true, f.agentId, { teams: context.teams });
  assert.equal(blocked.setup, null);
  assert.equal(blocked.problems[0].message, 'You need a manager of Operations to give this agent access.');
  await assert.rejects(
    service.saveDraft(f.w.id, f.user, f.agentId, await f.input({ setup: data.setup })),
    error => error.code === 'agent-team-assignment-required',
  );
  await f.db.platform.query(
    `UPDATE ${f.table('tf_member_teams')} SET role='manager' WHERE membership_id=$1 AND team_id=$2`,
    [f.member, data.teamId],
  );
  context = await saved.context(f.w.id, f.user);
  assert.equal(context.teams[0].canAssign, true);
  draft.access.enrollment = tableAccessEnrollment(context.teams, data.scope[0], []);
  const ready = parseBuilder(draft, f.member, true, f.agentId, { teams: context.teams });
  assert.ok(ready.setup);
  const staged = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input({ setup: ready.setup }));
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(staged));
  await f.accept(service, command);
  assert.equal((await service.advance(f.w.id, f.user, command.commandId)).status, 'active');
  const tasks = createAgentTasks(f.runtime),
    task = await tasks.start(f.w.id, f.user, {
      requestId: randomUUID(),
      agentId: f.agentId,
      text: 'Count the customer rows.',
    });
  const engine = createTaskRuntime(
    f.runtime,
    syntheticContinuity(async input => {
      const { results } = JSON.parse(input.prompt);
      if (!results.length) return { kind: 'tool', text: 'Find the table.', call: { tool: 'tables.list' } };
      const tables = results[0].result.tables;
      assert.deepEqual(
        tables.map(table => table.name),
        ['Customers'],
      );
      if (results.length === 1)
        return {
          kind: 'tool',
          text: 'Read the rows.',
          call: {
            tool: 'rows.list',
            tableId: tables[0].id,
            expectedAppliedRevision: tables[0].appliedRevision,
            query: {},
          },
        };
      assert.equal(results[1].result.records.length, 1);
      return { kind: 'answer', text: 'Customers has 1 row.' };
    }),
  );
  for (let step = 0; step < 8 && (await tasks.read(f.w.id, f.user, task.id)).status === 'pending'; step++)
    await engine.process(f.w.id, task.id);
  assert.equal((await tasks.read(f.w.id, f.user, task.id)).status, 'completed');
  assert.equal((await tasks.history(f.w.id, f.user, task.id)).messages.at(-1).text, 'Customers has 1 row.');
});

test('table enrollment keeps existing teams when a different manager or admin saves and activates', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime),
    data = await tableSetup(f);
  const editor = { user: randomUUID(), member: randomUUID() },
    readerTeam = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
    editor.member,
    editor.user,
  ]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Readers')`, [readerTeam]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
    editor.member,
    readerTeam,
  ]);
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
    [readerTeam, data.customers.tableId],
  );
  const setup = {
    ...data.setup,
    policy: {
      grants: [],
      personGrants: [
        { membershipId: f.member, permissions: ['read', 'edit', 'manage', 'invoke'] },
        { membershipId: editor.member, permissions: ['read', 'edit', 'manage', 'invoke'] },
        { membershipId: f.w.membershipId, permissions: ['read', 'edit', 'manage', 'invoke'] },
      ],
    },
  };
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input({ setup }));
  const first = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, first);
  assert.equal((await service.advance(f.w.id, f.user, first.commandId)).status, 'active');
  for (const user of [editor.user, f.w.userId]) {
    const state = await f.state(),
      current = {
        ...setup,
        definition: { ...setup.definition, instructions: `Count rows, edit ${state.agent.policy_version}.` },
      };
    const next = await service.saveDraft(
      f.w.id,
      user,
      f.agentId,
      await f.input({
        setup: current,
        expectedSavedRevision: state.agent.saved_revision,
        expectedPolicyVersion: state.agent.policy_version,
        expectedActivationIds: state.activations,
      }),
    );
    const command = await service.publish(f.w.id, user, f.agentId, f.decision(next));
    const definition = await service.definitionCommand(f.w.id, user, command.commandId);
    assert.equal((await f.worker.prepare(f.w.id, definition.commandId)).status, 'accepted');
    assert.equal((await service.advance(f.w.id, user, command.commandId)).status, 'active');
    assert.deepEqual((await createSavedAgentService(f.runtime).policy(f.w.id, user, f.agentId)).enrollment, [
      data.teamId,
    ]);
  }
  const state = await f.state(),
    expanded = [{ assetId: data.customers.tableId, permissions: ['table.row.read', 'table.row.update'] }];
  await assert.rejects(
    service.saveDraft(
      f.w.id,
      f.w.userId,
      f.agentId,
      await f.input({
        expectedVersion: 1,
        expectedSavedRevision: state.agent.saved_revision,
        expectedPolicyVersion: state.agent.policy_version,
        expectedActivationIds: state.activations,
        setup: { ...setup, scope: expanded, limits: expanded },
      }),
    ),
    error => error.code === 'agent-table-access-unavailable',
  );
});

test('draft choices persist inactive; publication has one Soul write and one activation across retries', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const weekdays = () => ({
    id: randomUUID(),
    trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Kolkata' },
  });
  const triggers = [weekdays(), { ...weekdays(), label: 'Second check' }];
  const value = await f.input({
    setup: { ...f.setup(), policy: { grants: [], personGrants: [] }, prompt: 'Check urgent tasks.', triggers },
  });
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, value);
  assert.deepEqual(await service.saveDraft(f.w.id, f.user, f.agentId, value), draft);
  assert.deepEqual((await service.readDraft(f.w.id, f.user, f.agentId)).setup, draft.setup);
  assert.equal((await f.state()).agent, undefined);
  const save = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft, 'save'));
  assert.deepEqual(await service.pending(f.w.id), [{ id: save.commandId, user_id: f.user }]);
  await f.accept(service, save);
  assert.equal((await service.advance(f.w.id, f.user, save.commandId)).status, 'saved');
  assert.equal((await f.state()).agent.enabled, false);
  assert.deepEqual((await f.state()).workflows, []);
  assert.equal(save.workflowId, null);
  const activationInput = f.decision(draft);
  const command = await service.publish(f.w.id, f.user, f.agentId, activationInput);
  assert.equal(
    (await createAgentSetup(f.runtime).readDraft(f.w.id, f.user, f.agentId)).commandId,
    command.commandId,
    'reload discovers the durable command without browser state',
  );
  assert.equal(f.writes(), 1);
  assert.equal(
    (await service.readCommand(f.w.id, f.user, command.commandId)).status,
    'preparing',
    'GET status cannot activate',
  );
  assert.deepEqual((await f.state()).activations, []);
  const done = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(done.status, 'active');
  assert.deepEqual(await service.advance(f.w.id, f.user, command.commandId), done);
  assert.equal((await service.publish(f.w.id, f.user, f.agentId, activationInput)).commandId, command.commandId);
  const active = await f.state();
  assert.equal(active.agent.enabled, true);
  assert.deepEqual(active.activations, [done.activationId]);
  assert.equal(active.workflows.length, 1, 'every trigger of the agent belongs to its one linked Workflow');
  const [row] = active.workflows;
  assert.equal(done.workflowId, row.id);
  assert.equal(row.id, agentLinkedWorkflowId(f.agentId));
  assert.equal(row.enabled, true);
  assert.equal(row.sponsor_membership_id, f.member, 'the consenting reviewer sponsors the unattended triggers');
  assert.equal(row.definition.name, 'Setup helper');
  assert.deepEqual(
    row.definition.triggers,
    triggers.map(selected => ({
      ...selected.trigger,
      id: agentWorkflowTriggerId(selected.id),
      ...(selected.label ? { label: selected.label } : {}),
    })),
  );
  assert.deepEqual(row.definition.steps, [
    {
      id: 'run_agent',
      kind: 'agent',
      agentId: f.agentId,
      prompt: { kind: 'literal', value: 'Check urgent tasks.' },
      context: { kind: 'input', path: [] },
      triggerContext: true,
      limits,
    },
  ]);
  assert.equal(f.writes(), 1);
  assert.equal(
    (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_agent_commands')}`)).rows[0].n,
    1,
  );
  assert.equal(
    (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_agent_tasks')}`)).rows[0].n,
    0,
  );
});

for (const resume of ['new-stage', 'fresh-page'])
  test(`empty-sharing creation retains its manager after Save draft and ${resume} activation`, async t => {
    const f = await environment(t),
      service = createAgentSetup(f.runtime);
    const localSetup = {
      ...f.setup(),
      policy: { grants: [], personGrants: [] },
      prompt: 'Check the daily queue.',
      triggers: [{ id: randomUUID(), trigger: { kind: 'interval', minutes: 60 } }],
    };
    const original = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input({ setup: localSetup }));
    const saved = await service.publish(f.w.id, f.user, f.agentId, f.decision(original, 'save'));
    await f.accept(service, saved);
    const accepted = await service.advance(f.w.id, f.user, saved.commandId);
    assert.equal(accepted.status, 'saved');
    assert.equal((await f.state()).agent.enabled, false);
    assert.deepEqual((await f.state()).activations, []);
    assert.deepEqual((await f.state()).workflows, []);

    const resumed = createAgentSetup(f.runtime);
    const restored = await resumed.readDraft(f.w.id, f.user, f.agentId);
    assert.equal(restored.commandId, saved.commandId);
    assert.equal(restored.digest, original.digest);
    assert.deepEqual(restored.setup, localSetup);
    assert.equal((await resumed.readCommand(f.w.id, f.user, restored.commandId)).savedRevision, accepted.savedRevision);
    const current = await f.state();
    const policy = await createSavedAgentService(f.runtime).policy(f.w.id, f.user, f.agentId);
    const reviewed =
      resume === 'fresh-page'
        ? restored
        : await resumed.saveDraft(
            f.w.id,
            f.user,
            f.agentId,
            await f.input({
              expectedVersion: restored.version,
              expectedSavedRevision: accepted.savedRevision,
              expectedPolicyVersion: policy.version,
              expectedActivationIds: current.activations,
              setup: localSetup,
            }),
          );
    assert.deepEqual(
      reviewed.setup.policy,
      { grants: [], personGrants: [] },
      'persisted intent is not rewritten to invent a sharing choice',
    );
    if (resume === 'new-stage') {
      assert.equal(reviewed.expectedSavedRevision, accepted.savedRevision);
      assert.notEqual(reviewed.digest, original.digest);
    }
    const decision = f.decision(reviewed);
    await assert.rejects(
      resumed.publish(f.w.id, f.user, f.agentId, { ...decision, digest: '0'.repeat(64) }),
      /setup-digest-conflict/,
    );
    const command = await resumed.publish(f.w.id, f.user, f.agentId, decision);
    if (resume === 'new-stage') await f.accept(resumed, command);
    assert.equal((await f.state()).agent.enabled, false, 'accepting a definition alone never starts the trigger');
    const activated = await resumed.advance(f.w.id, f.user, command.commandId);
    assert.equal(activated.status, 'active', activated.error);
    const activePolicy = await createSavedAgentService(f.runtime).policy(f.w.id, f.user, f.agentId);
    assert.deepEqual(activePolicy.grants, []);
    assert.deepEqual(activePolicy.personGrants, [
      { membershipId: f.member, permissions: ['delete', 'edit', 'invoke', 'manage', 'read'] },
    ]);
    assert.deepEqual((await f.state()).activations, [activated.activationId]);
    assert.equal((await f.state()).workflows.length, 1);
    assert.equal((await f.state()).workflows[0].definition.name, 'Setup helper');
    assert.equal(f.writes(), resume === 'new-stage' ? 2 : 1);
    assert.deepEqual(await resumed.advance(f.w.id, f.user, command.commandId), activated);
    assert.equal((await resumed.publish(f.w.id, f.user, f.agentId, decision)).commandId, command.commandId);
    assert.equal((await f.state()).workflows.length, 1);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_agents')}`)).rows[0].n,
      1,
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_agent_tasks')}`)).rows[0].n,
      0,
    );
  });

test('creation defaults do not override later reviewed creator permissions or allow a managerless edit', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const original = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({ setup: { ...f.setup(), policy: { grants: [], personGrants: [] } } }),
  );
  const first = await service.publish(f.w.id, f.user, f.agentId, f.decision(original));
  await f.accept(service, first);
  assert.equal((await service.advance(f.w.id, f.user, first.commandId)).status, 'active');
  const reducedPolicy = {
    grants: [],
    personGrants: [{ membershipId: f.member, permissions: ['read', 'edit', 'manage'] }],
  };
  for (const [index, selected] of [reducedPolicy, { grants: [], personGrants: [] }].entries()) {
    const current = await f.state();
    const draft = await service.saveDraft(
      f.w.id,
      f.user,
      f.agentId,
      await f.input({
        expectedVersion: index + 1,
        expectedSavedRevision: current.agent.saved_revision,
        expectedPolicyVersion: current.agent.policy_version,
        expectedActivationIds: current.activations,
        setup: { ...f.setup(), policy: selected },
      }),
    );
    const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
    await f.accept(service, command);
    const result = await service.advance(f.w.id, f.user, command.commandId);
    assert.equal(result.status, index === 0 ? 'active' : 'blocked');
    assert.equal(result.error, index === 0 ? null : 'manager-required');
    const policy = await createSavedAgentService(f.runtime).policy(f.w.id, f.user, f.agentId);
    assert.deepEqual(policy.personGrants, [{ membershipId: f.member, permissions: ['edit', 'manage', 'read'] }]);
    if (index === 1) {
      assert.equal((await f.state()).agent.enabled, true);
      assert.deepEqual((await f.state()).activations, current.activations);
      assert.equal(policy.version, current.agent.policy_version);
    }
  }
});

test('an inactive creation with explicitly changed policy does not restore creator defaults', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime),
    agents = createSavedAgentService(f.runtime);
  const original = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({ setup: { ...f.setup(), policy: { grants: [], personGrants: [] } } }),
  );
  const saved = await service.publish(f.w.id, f.user, f.agentId, f.decision(original, 'save'));
  await f.accept(service, saved);
  const accepted = await service.advance(f.w.id, f.user, saved.commandId);
  await agents.updatePolicy(f.w.id, f.user, f.agentId, {
    version: 0,
    owningTeamId: null,
    grants: [],
    personGrants: [{ membershipId: f.member, permissions: ['read', 'edit', 'manage'] }],
  });
  const policy = await agents.policy(f.w.id, f.user, f.agentId);
  const draft = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({
      expectedVersion: original.version,
      expectedSavedRevision: accepted.savedRevision,
      expectedPolicyVersion: policy.version,
      expectedActivationIds: [],
      setup: original.setup,
    }),
  );
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  const blocked = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error, 'manager-required');
  assert.deepEqual((await agents.policy(f.w.id, f.user, f.agentId)).personGrants, policy.personGrants);
  assert.equal((await f.state()).agent.policy_version, policy.version);
  assert.equal((await f.state()).agent.enabled, false);
  assert.deepEqual((await f.state()).activations, []);
});

test('a stopped setup keeps the original error class or code, never its message', async t => {
  const f = await environment(t);
  let failure;
  const service = createAgentSetup(f.runtime, undefined, {
    attachSlack: async () => {
      throw failure;
    },
  });
  const draft = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({
      setup: {
        ...f.setup(),
        slackChannels: [{ channel: 'C123', expectedVersion: 0, replaceAgentId: null }],
        prompt: 'Check once per hour.',
        triggers: [{ id: randomUUID(), trigger: { kind: 'interval', minutes: 60 } }],
      },
    }),
  );
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  for (const [error, code] of [
    [new TypeError('Cannot read private value of agent C123'), 'setup-type-error'],
    [Object.assign(new Error('deadlock detected on private relation'), { code: '40P01' }), 'setup-40p01'],
    [new Error('slack-membership-required'), 'slack-membership-required'],
    [new Error('A private sentence with no code'), 'setup-operation-unavailable'],
  ]) {
    failure = error;
    const result = await service.advance(f.w.id, f.user, command.commandId);
    assert.equal(result.status, 'blocked');
    assert.equal(result.error, code);
    assert.deepEqual(await service.readCommand(f.w.id, f.user, command.commandId), result);
  }
});

test('post-Soul setup failures roll back every DB effect and resume with stable IDs', async t => {
  const f = await environment(t);
  let blocked = true;
  const service = createAgentSetup(f.runtime, undefined, {
    attachSlack: async (tx, _workspace, _user, intent) => {
      await tx.client.query(
        `INSERT INTO ${f.table('tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'test.setup.slack',$3)`,
        [randomUUID(), f.member, f.agentId],
      );
      if (blocked) throw new AgentError('slack-membership-required');
      assert.equal(intent.channel, 'C123');
      return { version: 1, channelResponses: true };
    },
  });
  const draft = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({
      setup: {
        ...f.setup(),
        slackChannels: [{ channel: 'C123', expectedVersion: 0, replaceAgentId: null }],
        prompt: 'Check once per hour.',
        triggers: [{ id: randomUUID(), trigger: { kind: 'interval', minutes: 60 } }],
      },
    }),
  );
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  const result = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'slack-membership-required');
  assert.ok(result.savedRevision);
  const inactive = await f.state();
  assert.equal(inactive.agent.enabled, false);
  assert.equal(inactive.agent.policy_version, 0);
  assert.deepEqual(inactive.activations, []);
  assert.deepEqual(inactive.workflows, []);
  assert.equal(
    (
      await f.db.platform.query(
        `SELECT count(*)::integer AS n FROM ${f.table('tf_audit_events')} WHERE operation='test.setup.slack'`,
      )
    ).rows[0].n,
    0,
  );
  blocked = false;
  const active = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(active.status, 'active');
  assert.equal(active.activationId, command.activationId);
  assert.equal((await f.state()).workflows.length, 1);
  assert.equal(active.workflowId, (await f.state()).workflows[0].id);
  assert.deepEqual(await service.advance(f.w.id, f.user, command.commandId), active);
  assert.equal(
    (
      await f.db.platform.query(
        `SELECT count(*)::integer AS n FROM ${f.table('tf_audit_events')} WHERE operation='test.setup.slack'`,
      )
    ).rows[0].n,
    1,
  );
});

for (const creatorSelected of [false, true])
  test(`new setup preserves creator authority alongside team and person sharing (creator selected: ${creatorSelected})`, async t => {
    const f = await environment(t),
      service = createAgentSetup(f.runtime);
    const team = randomUUID(),
      colleague = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      colleague,
      randomUUID(),
    ]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Shared helpers')`, [team]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager')`,
      [f.member, team],
    );
    const selected = {
      grants: [{ teamId: team, permissions: ['read', 'invoke'] }],
      personGrants: [
        { membershipId: colleague, permissions: ['read', 'invoke'] },
        ...(creatorSelected ? [{ membershipId: f.member, permissions: ['read'] }] : []),
      ],
    };
    const draft = await service.saveDraft(
      f.w.id,
      f.user,
      f.agentId,
      await f.input({ setup: { ...f.setup(), policy: selected } }),
    );
    const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
    await f.accept(service, command);
    const published = await service.advance(f.w.id, f.user, command.commandId);
    assert.equal(published.status, 'active');
    const policy = await createSavedAgentService(f.runtime).policy(f.w.id, f.user, f.agentId);
    assert.deepEqual(policy.grants, [{ teamId: team, permissions: ['invoke', 'read'] }]);
    assert.deepEqual(policy.personGrants.find(grant => grant.membershipId === colleague)?.permissions, [
      'invoke',
      'read',
    ]);
    assert.deepEqual(policy.personGrants.find(grant => grant.membershipId === f.member)?.permissions, [
      'delete',
      'edit',
      'invoke',
      'manage',
      'read',
    ]);
    assert.equal(policy.personGrants.filter(grant => grant.membershipId === f.member).length, 1);
    assert.deepEqual(policy.enrollment, []);
    assert.deepEqual(await service.advance(f.w.id, f.user, command.commandId), published);
  });

test('editing saves a new revision but preserves the prior live setup until confirmed replacement succeeds', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const initial = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input());
  const first = await service.publish(f.w.id, f.user, f.agentId, f.decision(initial));
  await f.accept(service, first);
  const active = await service.advance(f.w.id, f.user, first.commandId);
  assert.equal(active.status, 'active');
  const before = await f.state();
  const edited = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({
      expectedVersion: 1,
      expectedSavedRevision: before.agent.saved_revision,
      expectedPolicyVersion: before.agent.policy_version,
      expectedActivationIds: before.activations,
      setup: {
        ...f.setup(),
        definition: { ...f.setup().definition, instructions: 'Changed reviewed instructions.' },
        slackChannels: [{ channel: 'C123', expectedVersion: 0, replaceAgentId: null }],
      },
    }),
  );
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(edited));
  await f.accept(service, command);
  assert.deepEqual((await f.state()).activations, before.activations);
  const blocked = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error, 'slack-channel-setup-unavailable');
  assert.equal((await f.state()).agent.enabled, true);
  assert.deepEqual((await f.state()).activations, before.activations);
  assert.equal((await f.state()).agent.policy_version, before.agent.policy_version);
  const allowed = createAgentSetup(f.runtime, undefined, {
    attachSlack: async () => ({ version: 1, channelResponses: true }),
  });
  assert.equal((await allowed.advance(f.w.id, f.user, command.commandId)).status, 'active');
  assert.deepEqual((await f.state()).activations, [command.activationId]);
});

test('review versions, replacement and current membership are enforced', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const value = await f.input({
    setup: {
      ...f.setup(),
      slackChannels: [{ channel: 'C123', expectedVersion: 2, replaceAgentId: randomUUID() }],
      prompt: 'Check.',
      triggers: [
        { id: randomUUID(), trigger: { kind: 'interval', minutes: 60 } },
        { id: randomUUID(), trigger: { kind: 'event', name: 'check_requested' } },
      ],
    },
  });
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, value);
  await assert.rejects(
    service.saveDraft(f.w.id, f.user, f.agentId, { ...value, setup: f.setup() }),
    /idempotency-conflict/,
  );
  await assert.rejects(
    service.saveDraft(f.w.id, f.user, f.agentId, { ...value, requestId: randomUUID() }),
    /setup-version-conflict/,
  );
  await assert.rejects(
    service.publish(f.w.id, f.user, f.agentId, { ...f.decision(draft), digest: '0'.repeat(64) }),
    /setup-digest-conflict/,
  );
  await assert.rejects(
    service.publish(f.w.id, f.user, f.agentId, {
      ...f.decision(draft),
      // An event trigger runs only when a member starts it, so consent stored per trigger need not name it.
      consent: { sponsorTriggerIds: [draft.setup.triggers[0].id], replaceChannels: [] },
    }),
    /slack-replacement-consent-required/,
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [f.member]);
  await assert.rejects(service.publish(f.w.id, f.user, f.agentId, f.decision(draft)));
  assert.equal((await f.state()).agent, undefined);
});

test('changed policy after Soul acceptance blocks activation without overwriting the newer policy', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input());
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  await createSavedAgentService(f.runtime).updatePolicy(f.w.id, f.user, f.agentId, {
    ...f.setup().policy,
    owningTeamId: null,
    version: 0,
  });
  const result = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'policy-version-conflict');
  assert.equal((await f.state()).agent.policy_version, 1);
  assert.equal((await f.state()).agent.enabled, false);
  assert.deepEqual((await f.state()).activations, []);
});

test('publication resume rechecks removed membership after Soul accepted the definition', async t => {
  const f = await environment(t),
    service = createAgentSetup(f.runtime);
  const draft = await service.saveDraft(f.w.id, f.user, f.agentId, await f.input());
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [f.member]);
  await assert.rejects(service.advance(f.w.id, f.user, command.commandId));
  assert.equal((await f.state()).agent.enabled, false);
  assert.deepEqual((await f.state()).activations, []);
  assert.deepEqual((await f.state()).workflows, []);
});

test('chat full setup approves the same coordinator or continues in the builder; historical drafts stay save-only', async t => {
  const f = await environment(t),
    chats = createConversations(f.runtime),
    drafts = createAuthoringDrafts(f.runtime);
  const context = await createSavedAgentService(f.runtime).context(f.w.id, f.user);
  assert.ok(context.builtinSkills.every(skill => skill.revision === 'latest'));
  const chatId = randomUUID();
  await chats.create(f.w.id, f.user, { chatId, commandId: randomUUID() });
  async function propose(full) {
    const sent = await chats.send(f.w.id, f.user, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Prepare an agent for review.' }],
    });
    let result;
    const { definition, owningTeamId, ...setup } = f.setup();
    let call = {
      tool: 'agents.draft',
      agent: 'new',
      input: {
        expectedSoulRevision: await f.head(),
        definition,
        owningTeamId,
        ...(full
          ? {
              setup,
              expectedPolicyVersion: 0,
              expectedActivationIds: [],
            }
          : {}),
      },
    };
    await createConversationExecutor(f.runtime, async ({ executeTool }) => {
      if (full) {
        const context = await executeTool('agents.context', false, context =>
          createChatTools(context.runtime).invoke(context, { tool: 'agents.context' }),
        );
        const resolved = nativeChatTools().resolve(
          { ...use('agents.draft', { agent: 'new', input: call.input }), id: 'draft', providerId: true },
          context,
        );
        assert.ok(resolved.ok);
        assert.equal(resolved.call.input.expectedWorkflowRevision, null);
        assert.equal(resolved.call.input.expectedWorkflowGeneration, null);
        call = resolved.call;
      }
      result = await executeTool('agents.draft', false, context =>
        createChatTools(context.runtime).invoke(context, call),
      );
      return { text: 'Review the exact setup.', sources: [] };
    }).process({ workspaceId: f.w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    return result;
  }
  const legacy = await propose(false);
  await assert.rejects(
    drafts.decide(f.w.id, f.user, chatId, legacy.draftId, {
      commandId: randomUUID(),
      digest: legacy.digest,
      decision: 'activate',
    }),
    /setup-review-required/,
  );
  const full = await propose(true);
  const decision = {
    commandId: randomUUID(),
    digest: full.digest,
    decision: 'activate',
    consent: { replaceChannels: [] },
  };
  const outcome = await drafts.decide(f.w.id, f.user, chatId, full.draftId, decision);
  assert.equal(outcome.kind, 'agent');
  assert.equal(outcome.setupReceipt.status, 'preparing');
  assert.equal((await f.worker.prepare(f.w.id, outcome.receipt.commandId)).status, 'accepted');
  const setup = createAgentSetup(f.runtime);
  assert.equal((await setup.advance(f.w.id, f.user, outcome.setupReceipt.commandId)).status, 'active');
  const reread = await drafts.read(f.w.id, f.user, chatId, full.draftId);
  assert.equal(reread.status, 'saved');
  assert.equal(reread.outcome.setupReceipt.status, 'active');
  const replayed = await drafts.decide(f.w.id, f.user, chatId, full.draftId, decision);
  assert.equal(replayed.setupReceipt.commandId, outcome.setupReceipt.commandId);
  assert.equal(replayed.setupReceipt.status, 'active');

  // Continuing a chat setup in the builder settles the chat draft and follows the builder's saves.
  const handed = await propose(true);
  const proceed = () => ({ commandId: randomUUID(), digest: handed.digest, decision: 'continue' });
  await assert.rejects(drafts.decide(f.w.id, f.user, chatId, handed.draftId, proceed()), /setup-draft-not-found/);
  const saved = await setup.saveDraft(f.w.id, f.user, handed.agentId, await f.input());
  assert.deepEqual(await drafts.decide(f.w.id, f.user, chatId, handed.draftId, proceed()), {
    kind: 'builder',
    agentId: handed.agentId,
  });
  assert.equal((await drafts.decide(f.w.id, f.user, chatId, handed.draftId, proceed())).kind, 'builder');
  assert.equal((await drafts.read(f.w.id, f.user, chatId, handed.draftId)).status, 'continued');
  await assert.rejects(
    drafts.decide(f.w.id, f.user, chatId, handed.draftId, {
      ...decision,
      commandId: randomUUID(),
      digest: handed.digest,
    }),
    /idempotency-conflict/,
  );
  const command = await setup.publish(f.w.id, f.user, handed.agentId, f.decision(saved, 'save'));
  await f.accept(setup, command);
  assert.equal((await setup.advance(f.w.id, f.user, command.commandId)).status, 'saved');
  const followed = await drafts.read(f.w.id, f.user, chatId, handed.draftId);
  assert.equal(followed.status, 'saved');
  assert.equal(followed.outcome.kind, 'builder');
  assert.equal(followed.outcome.setupReceipt.commandId, command.commandId);
});

async function activeAgent(f, triggers = [], prompt = 'Check the queue.') {
  const service = createAgentSetup(f.runtime);
  const draft = await service.saveDraft(
    f.w.id,
    f.user,
    f.agentId,
    await f.input({ setup: { ...f.setup(), ...(triggers.length ? { prompt } : {}), triggers } }),
  );
  const command = await service.publish(f.w.id, f.user, f.agentId, f.decision(draft));
  await f.accept(service, command);
  const active = await service.advance(f.w.id, f.user, command.commandId);
  assert.equal(active.status, 'active', active.error);
  return active;
}

test('archiving an agent archives only its trigger workflows; restoring brings them back disabled', async t => {
  const f = await environment(t),
    agents = createSavedAgentService(f.runtime);
  await activeAgent(f, [{ id: randomUUID(), trigger: { kind: 'interval', minutes: 60 } }]);
  const unlinkedId = randomUUID();
  await createWorkflows(f.runtime, { agentSteps: true }).save(f.w.id, f.user, unlinkedId, {
    revision: randomUUID(),
    expectedRevision: null,
    definition: agentLinkedDefinition(
      { id: f.agentId, name: 'Setup helper' },
      { prompt: 'Run by hand.', triggers: [] },
    ),
  });
  const unlinked = async () =>
    (
      await f.db.platform.query(
        `SELECT agent_id,archived_at,archived_with_agent FROM ${f.table('tf_workflows')} WHERE id=$1`,
        [unlinkedId],
      )
    ).rows[0];
  assert.deepEqual(await unlinked(), { agent_id: null, archived_at: null, archived_with_agent: false });
  assert.equal((await f.state()).workflows[0].enabled, true);

  await agents.archive(f.w.id, f.user, f.agentId);
  const [archived] = (await f.state()).workflows;
  assert.ok(archived.archived_at);
  assert.equal(archived.archived_with_agent, true);
  assert.equal(archived.enabled, false);
  assert.deepEqual(await unlinked(), { agent_id: null, archived_at: null, archived_with_agent: false });

  await agents.restore(f.w.id, f.user, f.agentId);
  const [restored] = (await f.state()).workflows;
  assert.equal(restored.archived_at, null);
  assert.equal(restored.archived_with_agent, false);
  assert.equal(restored.enabled, false, 'a restored trigger waits for a manager to turn it on');
  assert.deepEqual(await unlinked(), { agent_id: null, archived_at: null, archived_with_agent: false });
});
