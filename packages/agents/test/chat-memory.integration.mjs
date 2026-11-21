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
  async function tool(
    call,
    conversationId = chatId,
    invoke = context => createChatTools(context.runtime).invokeWithSources(context, call),
  ) {
    const sent = await chats.send(w.id, w.userId, conversationId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Update my memory.' }],
    });
    let output;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      output = (await executeTool(call.tool, false, invoke, [], call)).result;
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
  /** A card from before chat changed memory at once, as older chats still hold. */
  async function legacyCard(input) {
    const draftId = await tool({ tool: 'memory.edit' }, chatId, async context => ({
      result: (
        await createAuthoringDrafts(context.runtime).propose(
          context.workspaceId,
          context.actor,
          context.callId,
          context.origin,
          { kind: 'memory', input },
        )
      ).draftId,
      sources: [],
    }));
    return { draftId };
  }
  return {
    db,
    w,
    runtime,
    chats,
    chatId,
    drafts,
    tool,
    decide,
    legacyCard,
    keep,
    memory: createPersonalMemoryService(runtime),
  };
}

test('chat reads memory and edits it at once, refusing a stale revision', async t => {
  const { tool, memory, runtime, w } = await setup(t);
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
  assert.equal((await memory.read(w.id, w.userId)).content, 'I prefer short replies.');

  const edit = await tool({
    tool: 'memory.edit',
    revision: first.revision,
    content: 'I prefer short replies.\nI work in sales.',
  });
  const current = await memory.read(w.id, w.userId);
  assert.equal(edit.status, 'applied');
  assert.deepEqual(edit.change, { store: 'memory', operation: 'edit' });
  assert.equal(edit.revision, current.revision);
  assert.equal(current.content, 'I prefer short replies.\nI work in sales.');
  const drafts = await runtime.transaction(w.id, commonCompatibility, tx =>
    tx.client.query(`SELECT count(*)::int AS n FROM "${tx.schema}".tf_chat_authoring_drafts`),
  );
  assert.equal(drafts.rows[0].n, 0, 'no review card is made');
});

test('restore cards from the earlier memory never change Keep memory, even at a matching revision', async t => {
  const { db, legacyCard, decide, memory, drafts, chatId, runtime, w } = await setup(t);
  const live = await memory.save(w.id, w.userId, { content: 'Current memory.', expectedRevision: 0 });
  const card = await legacyCard({
    operation: 'edit',
    expectedRevision: live.revision,
    previousContent: 'Current memory.',
    content: 'Current memory.\nMore.',
  });
  const schema = await runtime.transaction(w.id, commonCompatibility, async tx => tx.schema);
  // The runtime role cannot rewrite a card, so plant the earlier store's restore card as the database owner.
  await db.databaseAdmin.query(
    `UPDATE "${schema}".tf_chat_authoring_drafts SET proposal = jsonb_set(proposal, '{input}', $2::jsonb) WHERE id=$1`,
    [
      card.draftId,
      JSON.stringify({
        operation: 'restore',
        expectedRevision: live.revision,
        previousContent: 'Current memory.',
        content: 'Earlier memory text.',
        forgotten: 'Earlier memory text.',
      }),
    ],
  );
  assert.equal((await drafts.read(w.id, w.userId, chatId, card.draftId)).status, 'stale');
  await assert.rejects(decide(card.draftId), { code: 'draft-stale' });
  assert.deepEqual(await memory.read(w.id, w.userId), live);
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

test('chat forget is permanent at once, keeps no copy, clears Bud preferences, and project chats never reach Keep', async t => {
  const { tool, memory, chats, runtime, w, keep } = await setup(t);
  const { calls } = keep;
  await memory.save(w.id, w.userId, { content: '- Lives in Berlin\n- Prefers tea', expectedRevision: 0 });
  await runtime.transaction(w.id, commonCompatibility, tx =>
    tx.client.query(
      `INSERT INTO "${tx.schema}".tf_bud_preferences
        (id, membership_id, conversation_id, turn_id, topic, question, value, status, expected_revision)
       VALUES ($1,$2,$3,$4,'role','What do you do?','Sales','saved',0)`,
      [randomUUID(), w.membershipId, randomUUID(), randomUUID()],
    ),
  );
  const count = table =>
    runtime
      .transaction(w.id, commonCompatibility, tx =>
        tx.client.query(`SELECT count(*)::int AS n FROM "${tx.schema}".${table}`),
      )
      .then(result => result.rows[0].n);

  const missing = await tool({ tool: 'memory.forget', text: 'Lives in Paris' });
  assert.equal(missing.error, 'not-found');
  assert.equal(await count('tf_bud_preferences'), 1);

  const forgotten = await tool({ tool: 'memory.forget', text: 'Lives in Berlin' });
  const current = await memory.read(w.id, w.userId);
  assert.equal(forgotten.status, 'applied');
  assert.deepEqual(forgotten.change, { store: 'memory', operation: 'forget' });
  assert.equal(forgotten.revision, current.revision);
  assert.equal(JSON.stringify(forgotten).includes('Lives in Berlin'), false, 'the result never repeats the text');
  assert.equal(current.content.includes('Lives in Berlin'), false);
  assert.match(current.content, /Prefers tea/);
  assert.equal(await count('tf_bud_preferences'), 0);
  assert.equal(await count('tf_chat_authoring_drafts'), 0, 'no card holds the forgotten text');

  const projectId = randomUUID(),
    projectChat = randomUUID();
  await createProjects(runtime).create(w.id, w.userId, { id: projectId, name: 'Shared' });
  await chats.create(w.id, w.userId, { chatId: projectChat, commandId: randomUUID(), projectId });
  const before = calls.length;
  assert.equal((await tool({ tool: 'memory.read' }, projectChat)).error, 'memory-unavailable');
  assert.equal((await tool({ tool: 'memory.forget', text: 'Prefers tea' }, projectChat)).error, 'memory-unavailable');
  assert.equal(calls.length, before);
});
