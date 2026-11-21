import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '../../conversations/src/index.ts';
import { configureKeepPersonalMemory, createPersonalMemoryService } from '../../conversations/src/personal-memory.ts';
import { createProjects } from '../../conversations/src/projects.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { fakeKeep } from '../../conversations/test/fake-keep.mjs';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createChatTools } from '../src/tools.ts';

async function setup(t) {
  const keep = fakeKeep();
  // The tools load the built conversations package; the test's service loads its source. Both must use the fake.
  t.after(configureKeepPersonalMemory({ client: keep.client }));
  t.after(
    (await import('@tulipfarm/conversations/personal-memory')).configureKeepPersonalMemory({ client: keep.client }),
  );
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
  return { w, runtime, chats, chatId, drafts, tool, decide, keep, memory: createPersonalMemoryService(runtime) };
}

test('chat reads memory and edits it only through an approved card', async t => {
  const { tool, decide, memory, drafts, chatId, w } = await setup(t);
  assert.deepEqual(await tool({ tool: 'memory.read' }), { content: '', revision: 0 });
  const first = await memory.save(w.id, w.userId, { content: 'I prefer short replies.', expectedRevision: 0 });
  assert.deepEqual(await tool({ tool: 'memory.read' }), {
    content: 'I prefer short replies.',
    revision: first.revision,
  });

  assert.equal(
    (await tool({ tool: 'memory.edit', revision: first.revision, content: 'I prefer short replies.' })).error,
    'no-change',
  );
  assert.equal((await tool({ tool: 'memory.edit', revision: 0, content: 'Other.' })).error, 'draft-stale');

  const edit = await tool({
    tool: 'memory.edit',
    revision: first.revision,
    content: 'I prefer short replies.\nI work in sales.',
  });
  assert.equal(edit.status, 'review-required');
  assert.equal((await memory.read(w.id, w.userId)).revision, first.revision);
  const saved = await decide(edit.draftId);
  assert.equal(saved.status, 'saved');
  const current = await memory.read(w.id, w.userId);
  assert.deepEqual(saved.outcome, { kind: 'memory', operation: 'edit', revision: current.revision });
  assert.equal(current.content, 'I prefer short replies.\nI work in sales.');

  const late = await tool({ tool: 'memory.edit', revision: current.revision, content: 'Replaced.' });
  await memory.save(w.id, w.userId, { content: 'Changed in settings.', expectedRevision: current.revision });
  assert.equal((await drafts.read(w.id, w.userId, chatId, late.draftId)).status, 'stale');
  await assert.rejects(decide(late.draftId), { code: 'draft-stale' });
  assert.equal((await memory.read(w.id, w.userId)).content, 'Changed in settings.');
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
    { tool: 'memory.edit', revision: 2, content: 'x' },
  ])
    assert.equal((await tool(call, projectChat)).error, 'memory-unavailable');
  assert.equal((await memory.read(w.id, w.userId)).content, 'Private note.');
});

test('chat forget asks first, is permanent, clears Bud preferences, and project chats never reach Keep', async t => {
  const { tool, decide, memory, chats, runtime, w, keep } = await setup(t);
  const { calls } = keep;
  const saved = await memory.save(w.id, w.userId, { content: '- Lives in Berlin\n- Prefers tea', expectedRevision: 0 });
  await runtime.transaction(w.id, commonCompatibility, tx =>
    tx.client.query(
      `INSERT INTO "${tx.schema}".tf_bud_preferences
        (id, membership_id, conversation_id, turn_id, topic, question, value, status, expected_revision)
       VALUES ($1,$2,$3,$4,'role','What do you do?','Sales','saved',0)`,
      [randomUUID(), w.membershipId, randomUUID(), randomUUID()],
    ),
  );
  const preferences = async () =>
    (
      await runtime.transaction(w.id, commonCompatibility, tx =>
        tx.client.query(`SELECT count(*)::int AS n FROM "${tx.schema}".tf_bud_preferences`),
      )
    ).rows[0].n;

  const stored = draftId =>
    runtime.transaction(w.id, commonCompatibility, async tx =>
      JSON.stringify(
        (
          await tx.client.query(`SELECT proposal,digest FROM "${tx.schema}".tf_chat_authoring_drafts WHERE id=$1`, [
            draftId,
          ])
        ).rows[0],
      ),
    );

  assert.equal((await tool({ tool: 'memory.forget', text: 'Lives in Paris' })).error, 'not-found');
  const asked = await tool({ tool: 'memory.forget', text: 'Lives in Berlin' });
  assert.equal(asked.status, 'confirm');
  assert.equal(await preferences(), 1, 'nothing changes before the member confirms');
  assert.equal((await memory.read(w.id, w.userId)).content, saved.content);
  const pending = await stored(asked.draftId);
  assert.ok(pending.includes('Lives in Berlin'));
  assert.equal(pending.includes('Prefers tea'), false, 'the card holds no copy of the memory');
  const forgotten = await decide(asked.draftId);
  assert.equal(forgotten.status, 'saved');
  assert.equal(forgotten.outcome.operation, 'forget');
  assert.equal(forgotten.proposal.input.forgotten, '');
  assert.equal((await stored(asked.draftId)).includes('Lives in Berlin'), false);
  assert.equal((await memory.read(w.id, w.userId)).content.includes('Lives in Berlin'), false);
  assert.equal(await preferences(), 0);

  const declined = await tool({ tool: 'memory.forget', text: 'Prefers tea' });
  assert.equal((await decide(declined.draftId, 'dismiss')).status, 'dismissed');
  assert.equal((await stored(declined.draftId)).includes('Prefers tea'), false);
  assert.match((await memory.read(w.id, w.userId)).content, /Prefers tea/);

  const projectId = randomUUID(),
    projectChat = randomUUID();
  await createProjects(runtime).create(w.id, w.userId, { id: projectId, name: 'Shared' });
  await chats.create(w.id, w.userId, { chatId: projectChat, commandId: randomUUID(), projectId });
  const before = calls.length;
  assert.equal((await tool({ tool: 'memory.read' }, projectChat)).error, 'memory-unavailable');
  assert.equal(calls.length, before);
});
