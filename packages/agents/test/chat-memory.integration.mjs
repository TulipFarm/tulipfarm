import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '../../conversations/src/index.ts';
import { createPersonalMemoryService } from '../../conversations/src/personal-memory.ts';
import { createProjects } from '../../conversations/src/projects.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createChatTools } from '../src/tools.ts';

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
  async function tool(call, conversationId = chatId) {
    const sent = await chats.send(w.id, w.userId, conversationId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Update my memory.' }],
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
      return { text: 'Done.', sources: [] };
    });
    await executor.process({ workspaceId: w.id, conversationId, turnId: sent.turnId, generation: 0 });
    return output;
  }
  const drafts = createAuthoringDrafts(runtime);
  async function decide(draftId, decision = 'save') {
    const pending = await drafts.read(w.id, w.userId, chatId, draftId);
    await drafts.decide(w.id, w.userId, chatId, draftId, { commandId: randomUUID(), digest: pending.digest, decision });
    return drafts.read(w.id, w.userId, chatId, draftId);
  }
  return { w, runtime, chats, chatId, drafts, tool, decide, memory: createPersonalMemoryService(runtime) };
}

test('chat reads memory and edits it only through an approved card', async t => {
  const { tool, decide, memory, drafts, chatId, w } = await setup(t);
  assert.deepEqual(await tool({ tool: 'memory.read' }), { content: '', revision: 0 });
  await memory.save(w.id, w.userId, { content: 'I prefer short replies.', expectedRevision: 0 });
  assert.deepEqual(await tool({ tool: 'memory.read' }), { content: 'I prefer short replies.', revision: 1 });

  assert.equal(
    (await tool({ tool: 'memory.edit', revision: 1, content: 'I prefer short replies.' })).error,
    'no-change',
  );
  assert.equal((await tool({ tool: 'memory.edit', revision: 0, content: 'Other.' })).error, 'draft-stale');

  const edit = await tool({ tool: 'memory.edit', revision: 1, content: 'I prefer short replies.\nI work in sales.' });
  assert.equal(edit.status, 'review-required');
  assert.equal((await memory.read(w.id, w.userId)).revision, 1);
  const saved = await decide(edit.draftId);
  assert.equal(saved.status, 'saved');
  assert.deepEqual(saved.outcome, { kind: 'memory', operation: 'edit', revision: 2 });
  assert.equal((await memory.read(w.id, w.userId)).content, 'I prefer short replies.\nI work in sales.');

  const late = await tool({ tool: 'memory.edit', revision: 2, content: 'Replaced.' });
  await memory.save(w.id, w.userId, { content: 'Changed in settings.', expectedRevision: 2 });
  assert.equal((await drafts.read(w.id, w.userId, chatId, late.draftId)).status, 'stale');
  await assert.rejects(decide(late.draftId), { code: 'draft-stale' });
  assert.equal((await memory.read(w.id, w.userId)).content, 'Changed in settings.');
});

test('chat forgets text at once, clears Bud preferences and offers an undo card', async t => {
  const { tool, decide, memory, drafts, chatId, runtime, w } = await setup(t);
  const original = '- Lives in Berlin\n- Prefers tea\n\nNotes: Lives in Berlin';
  await memory.save(w.id, w.userId, { content: original, expectedRevision: 0 });
  await runtime.transaction(w.id, commonCompatibility, tx =>
    tx.client.query(
      `INSERT INTO "${tx.schema}".tf_bud_preferences
        (id, membership_id, conversation_id, turn_id, topic, question, value, status, expected_revision)
       VALUES ($1,$2,$3,$4,'role','What do you do?','Sales','saved',0)`,
      [randomUUID(), w.membershipId, randomUUID(), randomUUID()],
    ),
  );

  assert.equal((await tool({ tool: 'memory.forget', text: 'Lives in Paris' })).error, 'not-found');
  const forgotten = await tool({ tool: 'memory.forget', text: 'Lives in Berlin' });
  assert.equal(forgotten.status, 'forgotten');
  assert.deepEqual(await memory.read(w.id, w.userId), { content: '- Prefers tea\n\nNotes: ', revision: 2 });
  const preferences = await runtime.transaction(w.id, commonCompatibility, tx =>
    tx.client.query(`SELECT count(*)::int AS n FROM "${tx.schema}".tf_bud_preferences`),
  );
  assert.equal(preferences.rows[0].n, 0);

  const undone = await decide(forgotten.draftId);
  assert.equal(undone.status, 'saved');
  assert.deepEqual(undone.outcome, { kind: 'memory', operation: 'restore', revision: 3 });
  assert.equal((await memory.read(w.id, w.userId)).content, original);

  const again = await tool({ tool: 'memory.forget', text: 'Prefers tea' });
  await memory.save(w.id, w.userId, { content: 'Newer.', expectedRevision: 4 });
  assert.equal((await drafts.read(w.id, w.userId, chatId, again.draftId)).status, 'stale');
  await assert.rejects(decide(again.draftId), { code: 'draft-stale' });
  assert.equal((await memory.read(w.id, w.userId)).content, 'Newer.');
});

test('memory tools refuse project chats', async t => {
  const { tool, chats, runtime, memory, w } = await setup(t);
  await memory.save(w.id, w.userId, { content: 'Private note.', expectedRevision: 0 });
  const projectId = randomUUID(),
    projectChat = randomUUID();
  await createProjects(runtime).create(w.id, w.userId, { id: projectId, name: 'Shared' });
  await chats.create(w.id, w.userId, { chatId: projectChat, commandId: randomUUID(), projectId });
  for (const call of [
    { tool: 'memory.read' },
    { tool: 'memory.forget', text: 'Private' },
    { tool: 'memory.edit', revision: 1, content: 'x' },
  ])
    assert.equal((await tool(call, projectChat)).error, 'memory-unavailable');
  assert.equal((await memory.read(w.id, w.userId)).content, 'Private note.');
});
