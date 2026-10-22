import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { readWorkspaceInventory } from '@tulipfarm/agents/tools';
import { createWorkspaceSkills } from '@tulipfarm/agents/workspace-skills';
import { createWorkflows } from '@tulipfarm/workflows';
import { createGeneration } from '@tulipfarm/tables/store';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { connect } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../../packages/tables/test/fixture.mjs';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { createConversationActivities } from '../src/conversation-activities.ts';
import {
  completionReply,
  isCompletionRequest,
  anthropicText,
  anthropicTools,
  isTitleRequest,
} from './native-chat-fixture.mjs';
import { useModelCatalog } from './model-catalog-fixture.mjs';

test('table and agent inventories include all pages, including an empty workspace', { timeout: 55000 }, async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace;
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  assert.deepEqual((await readWorkspaceInventory(f.runtime, w.id, actor)).inventory, {
    visibility: 'requester-readable',
    complete: true,
    tables: [],
    agents: [],
    workflows: [],
    skills: [],
  });
  const team = randomUUID(),
    tableIds = [],
    agentIds = [];
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Table owners')`, [team]);
  for (let index = 0; index < 101; index++) {
    const table = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      definition: tableDefinition({ owningTeamId: team, label: `Table ${index}` }),
    });
    tableIds.push(table.tableId);
    const agent = await savedTaskAgent(f.db, w, f.runtime, actor.userId, actor.membershipId, [], []);
    await f.db.platform.query(`UPDATE ${f.table('tf_teams')} SET name=$2 WHERE id=$1`, [
      agent.teamId,
      `Agent readers ${index}`,
    ]);
    agentIds.push(agent.agentId);
  }
  const { inventory } = await readWorkspaceInventory(f.runtime, w.id, actor);
  assert.deepEqual(
    inventory.tables.map(item => item.id),
    tableIds.sort(),
  );
  assert.deepEqual(
    inventory.agents.map(item => item.id),
    agentIds.sort(),
  );
  assert.equal(inventory.complete, true);
  const pending = tableDefinition({ owningTeamId: team, label: 'Pending application' });
  const migration = await connect(f.db.login(w, 'migration'));
  try {
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      await createGeneration({ client, schema: w.names.schema }, { definition: pending, revision: 'b'.repeat(40) });
    });
  } finally {
    await migration.end();
  }
  const pendingSnapshot = await readWorkspaceInventory(f.runtime, w.id, actor);
  assert.deepEqual(
    pendingSnapshot.inventory.tables.find(table => table.id === pending.id),
    {
      id: pending.id,
      name: 'Pending application',
      savedRevision: 'b'.repeat(40),
      appliedRevision: null,
      maintenance: false,
    },
  );
});

test(
  'default private chat receives complete authorized inventory and reads a known table without discovery',
  { timeout: 55000 },
  async t => {
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace;
    const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    const other = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member'),($3,$4,'member')`,
      [actor.membershipId, actor.userId, other.membershipId, other.userId],
    );
    const team = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Inventory readers')`, [team]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
      actor.membershipId,
      team,
    ]);
    const field = textField('SCHEMA_FIELD_NOT_IN_INDEX');
    const visible = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      definition: tableDefinition({ owningTeamId: team, label: 'Tickets', fields: [field] }),
      records: [{ values: textValues(field, 'ROW_DATA_NOT_IN_INDEX') }],
    });
    const hidden = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      definition: tableDefinition({ owningTeamId: team, label: 'HIDDEN_HR_TABLE' }),
    });
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [team, visible.tableId],
    );

    const agent = await savedTaskAgent(f.db, w, f.runtime, actor.userId, actor.membershipId, [], []);
    await f.db.platform.query(`UPDATE ${f.table('tf_teams')} SET name='Visible agent invokers' WHERE id=$1`, [
      agent.teamId,
    ]);
    const hiddenAgent = await savedTaskAgent(f.db, w, f.runtime, other.userId, other.membershipId, [], []);
    await f.db.platform.query(`UPDATE ${f.table('tf_agents')} SET display_name=$2 WHERE id=$1`, [
      hiddenAgent.agentId,
      'HIDDEN_HR_AGENT',
    ]);

    const workflows = createWorkflows(f.runtime);
    const definition = name => ({
      version: 1,
      name,
      trigger: { kind: 'manual' },
      steps: [{ id: 'review', kind: 'human', prompt: 'WORKFLOW_BODY_NOT_IN_INDEX', timeoutSeconds: 60 }],
    });
    const workflow = await workflows.save(w.id, actor.userId, randomUUID(), {
      revision: randomUUID(),
      expectedRevision: null,
      definition: definition('Ticket review'),
    });
    await workflows.save(w.id, other.userId, randomUUID(), {
      revision: randomUUID(),
      expectedRevision: null,
      definition: definition('HIDDEN_HR_WORKFLOW'),
    });

    const skills = createWorkspaceSkills(f.runtime);
    const skillIds = [];
    for (let index = 0; index < 101; index++) {
      const id = randomUUID();
      const saved = await skills.save(w.id, actor, id, {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: {
          name: `Ticket procedure ${index}`,
          description: 'Handle a ticket.',
          instructions: 'SKILL_BODY_NOT_IN_INDEX',
        },
      });
      await skills.review(w.id, actor.userId, id, {
        requestId: randomUUID(),
        expectedVersion: 1,
        revision: saved.savedRevision,
      });
      skillIds.push(id);
    }
    const hiddenSkillId = randomUUID();
    const savedHidden = await skills.save(w.id, other, hiddenSkillId, {
      requestId: randomUUID(),
      expectedVersion: 0,
      definition: { name: 'HIDDEN_HR_SKILL', description: 'Private.', instructions: 'Private.' },
    });
    await skills.review(w.id, other.userId, hiddenSkillId, {
      requestId: randomUUID(),
      expectedVersion: 1,
      revision: savedHidden.savedRevision,
    });
    const unreviewed = randomUUID();
    await skills.save(w.id, actor, unreviewed, {
      requestId: randomUUID(),
      expectedVersion: 0,
      definition: { name: 'UNREVIEWED_SKILL', description: 'Not yet reviewed.', instructions: 'Private draft.' },
    });

    const snapshot = await readWorkspaceInventory(f.runtime, w.id, actor);
    assert.deepEqual(snapshot.inventory.tables, [
      {
        id: visible.tableId,
        name: 'Tickets',
        savedRevision: visible.revision,
        appliedRevision: visible.revision,
        maintenance: false,
      },
    ]);
    assert.deepEqual(
      snapshot.inventory.agents.map(item => item.id),
      [agent.agentId],
    );
    assert.deepEqual(snapshot.inventory.workflows, [
      { id: workflow.id, name: 'Ticket review', revision: workflow.revision, activeRevision: null, enabled: false },
    ]);
    assert.deepEqual(snapshot.inventory.skills.map(item => item.id).sort(), skillIds.sort());
    assert.equal(snapshot.inventory.complete, true);
    assert.doesNotMatch(
      JSON.stringify(snapshot.inventory),
      /HIDDEN_HR|NOT_IN_INDEX|UNREVIEWED_SKILL|instructions|definition":|fields":/,
    );

    const priorKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
    t.after(() => {
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = priorKey;
    });
    t.after(useModelCatalog());
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Ticket schema'));
      requests.push(body);
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      return Response.json(
        requests.length === 1
          ? anthropicTools([{ tool: 'schema.inspect', tableId: visible.tableId }])
          : anthropicText('The ticket table exists.'),
      );
    });
    const chatId = randomUUID();
    await f.store.create(w.id, actor.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, actor.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Read the ticket schema.' }],
    });
    assert.equal(
      await createConversationActivities(f.runtime).processConversationReply({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: 0,
      }),
      'completed',
    );
    assert.equal(requests.length, 3);
    assert.match(JSON.stringify(requests[0]), /workspaceInventory/);
    assert.doesNotMatch(JSON.stringify(requests[0]), /HIDDEN_HR|NOT_IN_INDEX|UNREVIEWED_SKILL/);
    const history = await f.store.history(w.id, actor.userId, chatId);
    assert.deepEqual(
      history.messages[0].tools.map(tool => tool.tool),
      ['schema.inspect'],
    );
    assert.doesNotMatch(JSON.stringify(history), /workspaceInventory|Ticket procedure/);
    assert.equal(history.messages[1].parts[0].text, 'The ticket table exists.');
    const dependencies = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_model_sources')} WHERE turn_id=$1`, [
        sent.turnId,
      ])
    ).rows;
    assert.ok(
      dependencies.some(row =>
        row.sources.some(source => source.kind === 'table-schema' && source.tableId === visible.tableId),
      ),
    );

    await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE asset_id=$1`, [visible.tableId]);
    await f.db.platform.query(`DELETE FROM ${f.table('tf_agent_grants')} WHERE agent_id=$1`, [agent.agentId]);
    await skills.setEnabled(w.id, actor.userId, skillIds[0], {
      requestId: randomUUID(),
      expectedVersion: 2,
      enabled: false,
    });
    const refreshed = (await readWorkspaceInventory(f.runtime, w.id, actor)).inventory;
    assert.deepEqual(refreshed.tables, []);
    assert.deepEqual(refreshed.agents, []);
    assert.equal(refreshed.skills.length, 100);
    assert.ok(!refreshed.skills.some(skill => skill.id === skillIds[0]));
    assert.doesNotMatch(JSON.stringify(refreshed), new RegExp(hidden.tableId));
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
      actor.membershipId,
    ]);
    await assert.rejects(readWorkspaceInventory(f.runtime, w.id, actor), AccessDenied);
  },
);
