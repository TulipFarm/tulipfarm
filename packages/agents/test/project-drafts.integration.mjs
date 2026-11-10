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
import { createChatTools } from '../src/tools.ts';
import { createProjectMembership } from '../../conversations/src/project-membership.ts';

async function setup(t, options = {}) {
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
    ...options,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const chats = createConversations(runtime),
    chatId = randomUUID();
  await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  async function tool(call) {
    const sent = await chats.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Sort out my projects.' }],
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

test('draft reads do not wait for chat activity, while competing decisions commit only once', async t => {
  const { db, w, chatId, drafts, tool, table } = await setup(t, { lockTimeoutMs: 1000 });
  const proposed = await tool({ tool: 'projects.draft', name: 'Launch', instructions: 'Keep replies short.' });
  await db.databaseAdmin.query('BEGIN');
  try {
    await db.databaseAdmin.query(`SELECT id FROM ${table('tf_conversations')} WHERE id=$1 FOR UPDATE`, [chatId]);
    const cards = await Promise.all(
      Array.from({ length: 4 }, () => drafts.read(w.id, w.userId, chatId, proposed.draftId)),
    );
    assert.ok(cards.every(card => card.status === 'pending'));
  } finally {
    await db.databaseAdmin.query('ROLLBACK');
  }
  const decisions = ['save', 'dismiss'].map(decision => ({
    commandId: randomUUID(),
    digest: proposed.digest,
    decision,
  }));
  const results = await Promise.allSettled(
    decisions.map(decision => drafts.decide(w.id, w.userId, chatId, proposed.draftId, decision)),
  );
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'idempotency-conflict');
  const stored = await db.platform.query(
    `SELECT input,outcome FROM ${table('tf_chat_authoring_decisions')} WHERE draft_id=$1`,
    [proposed.draftId],
  );
  assert.equal(stored.rowCount, 1);
  const { input, outcome } = stored.rows[0];
  assert.deepEqual(await drafts.decide(w.id, w.userId, chatId, proposed.draftId, input), outcome);
  const card = await drafts.read(w.id, w.userId, chatId, proposed.draftId);
  assert.equal(card.status, outcome.kind === 'dismissed' ? 'dismissed' : 'saved');
  const projects = await db.platform.query(`SELECT id FROM ${table('tf_projects')}`);
  assert.equal(projects.rowCount, outcome.kind === 'dismissed' ? 0 : 1);
});

test('closing a source-denied draft still locks the chat before recording an unavailable outcome', async t => {
  const { db, w, chatId, drafts, tool, table } = await setup(t, { lockTimeoutMs: 1000 });
  const proposed = await tool({ tool: 'projects.draft', name: 'Launch', instructions: 'Keep replies short.' });
  await db.platform.query(`UPDATE ${table('tf_chat_authoring_drafts')} SET sources=$2 WHERE id=$1`, [
    proposed.draftId,
    JSON.stringify([{ kind: 'private-conversation', conversationId: randomUUID() }]),
  ]);
  await db.databaseAdmin.query('BEGIN');
  try {
    await db.databaseAdmin.query(`SELECT id FROM ${table('tf_conversations')} WHERE id=$1 FOR UPDATE`, [chatId]);
    await assert.rejects(drafts.read(w.id, w.userId, chatId, proposed.draftId), { code: '55P03' });
    const decisions = await db.platform.query(
      `SELECT outcome FROM ${table('tf_chat_authoring_decisions')} WHERE draft_id=$1`,
      [proposed.draftId],
    );
    assert.equal(decisions.rowCount, 0, 'the read cannot close a draft before obtaining the chat lock');
  } finally {
    await db.databaseAdmin.query('ROLLBACK');
  }
  await assert.rejects(drafts.read(w.id, w.userId, chatId, proposed.draftId), { message: 'Resource not found' });
  const decisions = await db.platform.query(
    `SELECT outcome FROM ${table('tf_chat_authoring_decisions')} WHERE draft_id=$1`,
    [proposed.draftId],
  );
  assert.deepEqual(
    decisions.rows.map(row => row.outcome),
    [{ kind: 'unavailable' }],
  );
});

test('chat creates, edits, archives and restores a project only after the human approves each card', async t => {
  const { db, w, runtime, chatId, drafts, tool, approve, table } = await setup(t);
  const projects = createProjectMembership(runtime);
  const names = () =>
    projects.list(w.id, w.userId).then(list => list.map(item => `${item.name}${item.archived ? ' (archived)' : ''}`));

  assert.equal((await tool({ tool: 'projects.draft', instructions: 'No name' })).error, 'invalid-arguments');
  const declined = await tool({ tool: 'projects.draft', name: 'Not needed', instructions: 'Keep replies short.' });
  await drafts.decide(w.id, w.userId, chatId, declined.draftId, {
    commandId: randomUUID(),
    digest: declined.digest,
    decision: 'dismiss',
  });
  const dismissed = await drafts.read(w.id, w.userId, chatId, declined.draftId);
  assert.equal(dismissed.status, 'dismissed');
  assert.deepEqual(dismissed.outcome, { kind: 'dismissed' });
  assert.deepEqual(await names(), [], 'declining creates nothing');
  const create = await tool({ tool: 'projects.draft', name: 'Launch', instructions: 'Keep replies short.' });
  const card = await drafts.read(w.id, w.userId, chatId, create.draftId);
  assert.equal(card.proposal.kind, 'project');
  assert.equal(card.proposal.input.current, null);
  assert.deepEqual(await names(), [], 'proposing creates nothing');
  const created = await approve(create);
  assert.equal(created.status, 'saved');
  assert.equal(created.outcome.projectId, card.proposal.targetId);
  assert.deepEqual(await names(), ['Launch']);

  const listed = await tool({ tool: 'projects.list' });
  assert.deepEqual(
    listed.projects.map(({ name, manager, archived }) => ({ name, manager, archived })),
    [{ name: 'Launch', manager: true, archived: false }],
  );
  assert.equal(listed.projects[0].instructions, undefined, 'the list leaves instructions to projects.read');
  const read = await tool({ tool: 'projects.read', projectId: card.proposal.targetId });
  assert.equal(read.instructions, 'Keep replies short.');
  assert.equal(read.members, 1);
  assert.deepEqual(read.knowledge, []);

  assert.equal(
    (await tool({ tool: 'projects.draft', projectId: read.id, revision: read.revision, name: 'Launch' })).error,
    'no-change',
  );
  assert.equal(
    (await tool({ tool: 'projects.draft', projectId: read.id, revision: read.revision + 1, name: 'Go' })).error,
    'project-changed',
  );
  const edit = await tool({
    tool: 'projects.draft',
    projectId: read.id,
    revision: read.revision,
    instructions: 'Cite sources.',
  });
  assert.equal((await approve(edit)).status, 'saved');
  const edited = await tool({ tool: 'projects.read', projectId: read.id });
  assert.deepEqual([edited.name, edited.instructions], ['Launch', 'Cite sources.'], 'only the drafted field changes');

  const stale = await tool({ tool: 'projects.draft', projectId: read.id, revision: edited.revision, name: 'Launch 2' });
  await projects.edit(w.id, w.userId, read.id, {
    expectedRevision: edited.revision,
    name: 'Renamed elsewhere',
    instructions: edited.instructions,
    archived: false,
  });
  assert.equal((await drafts.read(w.id, w.userId, chatId, stale.draftId)).status, 'stale');
  await drafts
    .decide(w.id, w.userId, chatId, stale.draftId, { commandId: randomUUID(), digest: stale.digest, decision: 'save' })
    .catch(() => {});
  assert.deepEqual(await names(), ['Renamed elsewhere']);

  const current = await tool({ tool: 'projects.read', projectId: read.id });
  const archive = await tool({
    tool: 'projects.draft',
    projectId: read.id,
    revision: current.revision,
    archived: true,
  });
  assert.deepEqual(await names(), ['Renamed elsewhere'], 'proposing an archive changes nothing');
  assert.equal((await approve(archive)).status, 'saved');
  assert.deepEqual(await names(), ['Renamed elsewhere (archived)']);
  assert.deepEqual((await tool({ tool: 'projects.list' })).projects, []);
  const archived = (await tool({ tool: 'projects.list', archived: true })).projects;
  assert.deepEqual(
    archived.map(item => item.id),
    [read.id],
  );

  const restore = await tool({
    tool: 'projects.draft',
    projectId: read.id,
    revision: archived[0].revision,
    archived: false,
  });
  assert.equal((await approve(restore)).status, 'saved');
  assert.deepEqual(await names(), ['Renamed elsewhere']);

  const latest = await tool({ tool: 'projects.read', projectId: read.id });
  await db.platform.query(`UPDATE ${table('tf_project_members')} SET role='member' WHERE project_id=$1`, [read.id]);
  assert.equal(
    (await tool({ tool: 'projects.draft', projectId: read.id, revision: latest.revision, archived: true })).error,
    'project-manager-required',
    'a member who does not manage the project cannot draft a change',
  );
});
