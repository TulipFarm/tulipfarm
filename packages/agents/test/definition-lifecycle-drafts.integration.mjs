import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createSavedAgentService } from '../src/saved-service.ts';
import { createChatTools } from '../src/tools.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { savedTaskAgent } from './task-fixture.mjs';

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
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const chats = createConversations(runtime),
    chatId = randomUUID();
  await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  async function tool(call) {
    const sent = await chats.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Tidy these up.' }],
    });
    let output;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      output = (
        await executeTool(
          call.tool,
          false,
          context => createChatTools(context.runtime).invokeWithSources(context, call),
          [],
          call,
        )
      ).result;
      return { text: 'Review the card.', sources: [] };
    });
    await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    return output;
  }
  const drafts = createAuthoringDrafts(runtime);
  async function approve(proposed) {
    assert.equal((await drafts.read(w.id, w.userId, chatId, proposed.draftId)).status, 'pending');
    const decision = { commandId: randomUUID(), digest: proposed.digest, decision: 'save' };
    await drafts.decide(w.id, w.userId, chatId, proposed.draftId, decision);
    await drafts.decide(w.id, w.userId, chatId, proposed.draftId, decision);
    return drafts.read(w.id, w.userId, chatId, proposed.draftId);
  }
  return { db, w, runtime, chatId, drafts, tool, approve, table: name => qualified(w.names.schema, name) };
}

test('chat archives and restores agents only after the human approves one card', async t => {
  const { db, w, runtime, chatId, drafts, tool, approve, table } = await setup(t);
  const agents = createSavedAgentService(runtime);
  const first = await savedTaskAgent(db, w, runtime, w.userId, w.membershipId);
  const second = await savedTaskAgent(db, w, runtime, w.userId, w.membershipId);
  await db.platform.query(`UPDATE ${table('tf_agents')} SET display_name='Lead triage' WHERE id=$1`, [second.agentId]);
  const ids = () => agents.list(w.id, w.userId).then(page => page.agents.map(item => item.id).sort());
  const before = await ids();

  assert.equal(
    (await tool({ tool: 'agents.archive', agentIds: [first.agentId] })).error,
    'agent-delete-required',
    'a manager without the delete grant cannot archive',
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$3,'delete'),($2,$3,'delete')`,
    [first.agentId, second.agentId, w.membershipId],
  );
  assert.equal(
    (await tool({ tool: 'agents.archive', agentIds: [first.agentId, first.agentId] })).error,
    'invalid-arguments',
  );
  assert.equal((await tool({ tool: 'agents.restore', agentIds: [first.agentId] })).error, 'agent-not-archived');

  const archive = await tool({ tool: 'agents.archive', agentIds: [first.agentId, second.agentId] });
  const card = await drafts.read(w.id, w.userId, chatId, archive.draftId);
  assert.equal(card.proposal.kind, 'agent-archive');
  assert.deepEqual(
    card.proposal.input.agents.map(agent => agent.name),
    ['Private assistant', 'Lead triage'],
    'the card names every agent it will archive',
  );
  assert.deepEqual(await ids(), before, 'proposing archives nothing');

  assert.equal((await approve(archive)).status, 'saved');
  assert.ok(!(await ids()).includes(first.agentId) && !(await ids()).includes(second.agentId));
  const archived = await tool({ tool: 'agents.list', archived: true });
  assert.deepEqual(archived.agents.map(item => item.id).sort(), [first.agentId, second.agentId].sort());
  const kept = (
    await db.platform.query(
      `SELECT owning_team_id IS NOT NULL AS team, enabled, (SELECT count(*)::int FROM ${table('tf_agent_activations')} x WHERE x.agent_id=a.id AND x.revoked_at IS NULL) AS live FROM ${table('tf_agents')} a WHERE id=$1`,
      [first.agentId],
    )
  ).rows[0];
  assert.deepEqual(kept, { team: true, enabled: false, live: 0 }, 'archive keeps the team and ends activations');
  assert.equal((await tool({ tool: 'agents.archive', agentIds: [first.agentId] })).error, 'agent-archived');

  const restore = await tool({ tool: 'agents.restore', agentIds: [first.agentId] });
  assert.ok(!(await ids()).includes(first.agentId), 'proposing a restore changes nothing');
  assert.equal((await approve(restore)).status, 'saved');
  assert.ok((await ids()).includes(first.agentId));
  assert.equal(
    (await db.platform.query(`SELECT enabled FROM ${table('tf_agents')} WHERE id=$1`, [first.agentId])).rows[0].enabled,
    false,
    'a restored agent stays off',
  );
  assert.deepEqual(
    (await agents.list(w.id, w.userId, { archived: true })).agents.map(item => item.id),
    [second.agentId],
  );
});

test('chat archives and restores workspace skills only after approval, and refuses a stale card', async t => {
  const { w, runtime, chatId, drafts, tool, approve } = await setup(t);
  const skills = createWorkspaceSkills(runtime);
  const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  async function reviewedSkill(name) {
    const id = randomUUID();
    const saved = await skills.save(w.id, admin, id, {
      requestId: randomUUID(),
      expectedVersion: 0,
      definition: { name, description: `${name} for the team.`, instructions: 'Follow the steps.' },
    });
    await skills.review(w.id, admin, id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      revision: saved.savedRevision,
    });
    return id;
  }
  const qualify = await reviewedSkill('Qualify lead'),
    digest = await reviewedSkill('Weekly digest');
  const listed = async archived =>
    (await tool({ tool: 'skills.workspace', ...(archived ? { archived: true } : {}) })).workspace
      .map(item => item.id)
      .filter(id => id === qualify || id === digest)
      .sort();

  assert.equal((await tool({ tool: 'skills.restore', skillIds: [qualify] })).error, 'skill-not-archived');
  const archive = await tool({ tool: 'skills.archive', skillIds: [qualify, digest] });
  const card = await drafts.read(w.id, w.userId, chatId, archive.draftId);
  assert.equal(card.proposal.kind, 'skill-archive');
  assert.deepEqual(
    card.proposal.input.skills.map(skill => skill.name),
    ['Qualify lead', 'Weekly digest'],
  );
  assert.deepEqual(await listed(false), [qualify, digest].sort(), 'proposing archives nothing');
  assert.equal((await approve(archive)).status, 'saved');
  assert.deepEqual(await listed(false), []);
  assert.deepEqual(await listed(true), [qualify, digest].sort());
  assert.equal((await tool({ tool: 'skills.archive', skillIds: [qualify] })).error, 'skill-archived');

  const late = await tool({ tool: 'skills.restore', skillIds: [digest] });
  const current = await skills.read(w.id, admin, digest);
  await skills.setLifecycle(w.id, admin, digest, {
    requestId: randomUUID(),
    expectedVersion: current.management.version,
    lifecycle: 'active',
  });
  await skills.setLifecycle(w.id, admin, digest, {
    requestId: randomUUID(),
    expectedVersion: current.management.version + 1,
    lifecycle: 'archived',
  });
  assert.equal((await drafts.read(w.id, w.userId, chatId, late.draftId)).status, 'stale');
  await assert.rejects(
    drafts.decide(w.id, w.userId, chatId, late.draftId, {
      commandId: randomUUID(),
      digest: late.digest,
      decision: 'save',
    }),
  );

  const restore = await tool({ tool: 'skills.restore', skillIds: [qualify, digest] });
  assert.equal((await approve(restore)).status, 'saved');
  assert.deepEqual(await listed(false), [qualify, digest].sort());
  assert.deepEqual(await listed(true), []);
});
