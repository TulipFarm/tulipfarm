import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createChatTools } from '../src/tools.ts';
import { createFiles } from '../../files/src/index.ts';

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
      parts: [{ kind: 'text', text: 'Update my Knowledge.' }],
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
  const objects = new Map();
  const bytes = {
    putIfAbsent: async (key, body) => void objects.set(key, Buffer.from(body)),
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => void objects.delete(key),
  };
  const drafts = createAuthoringDrafts(runtime, undefined, undefined, undefined, undefined, undefined, bytes);
  async function approve(proposed) {
    assert.equal((await drafts.read(w.id, w.userId, chatId, proposed.draftId)).status, 'pending');
    const decision = { commandId: randomUUID(), digest: proposed.digest, decision: 'save' };
    await drafts.decide(w.id, w.userId, chatId, proposed.draftId, decision);
    await drafts.decide(w.id, w.userId, chatId, proposed.draftId, decision);
    return drafts.read(w.id, w.userId, chatId, proposed.draftId);
  }
  return { w, runtime, chatId, drafts, tool, approve, files: createFiles(runtime, bytes) };
}

test('chat adds, updates and removes a Knowledge note only through approved cards', async t => {
  const { tool, approve, drafts, w, chatId } = await setup(t);
  const added = await tool({ tool: 'knowledge.add', title: 'Pricing', text: 'Starter is $10.' });
  assert.equal(added.status, 'review-required');
  assert.deepEqual((await tool({ tool: 'knowledge.list' })).entries, []);
  const saved = await approve(added);
  assert.equal(saved.status, 'saved');
  assert.deepEqual(saved.outcome, { kind: 'knowledge', operation: 'add', documentId: added.documentId });

  const [entry] = (await tool({ tool: 'knowledge.list' })).entries;
  assert.equal(entry.title, 'Pricing');
  assert.equal(
    (await tool({ tool: 'knowledge.list', documentId: entry.documentId })).entry.noteText,
    'Starter is $10.',
  );
  assert.equal(
    (
      await tool({
        tool: 'knowledge.update',
        documentId: entry.documentId,
        revisionId: entry.revisionId,
        title: 'Pricing',
      })
    ).error,
    'no-change',
  );

  const first = await tool({
    tool: 'knowledge.update',
    documentId: entry.documentId,
    revisionId: entry.revisionId,
    text: 'Starter is $12.',
  });
  const second = await tool({
    tool: 'knowledge.update',
    documentId: entry.documentId,
    revisionId: entry.revisionId,
    title: 'Plans and pricing',
  });
  assert.equal((await approve(second)).status, 'saved');
  // The first card was drafted against the replaced revision, so approving it now would lose the new title.
  assert.equal((await drafts.read(w.id, w.userId, chatId, first.draftId)).status, 'stale');
  await assert.rejects(
    drafts.decide(w.id, w.userId, chatId, first.draftId, {
      commandId: randomUUID(),
      digest: first.digest,
      decision: 'save',
    }),
    { code: 'draft-stale' },
  );
  const updated = (await tool({ tool: 'knowledge.list', documentId: entry.documentId })).entry;
  assert.equal(updated.title, 'Plans and pricing');
  assert.equal(updated.noteText, 'Starter is $10.');

  const removed = await tool({ tool: 'knowledge.remove', documentId: entry.documentId, revisionId: entry.revisionId });
  assert.equal(removed.error, 'draft-stale');
  const removal = await tool({
    tool: 'knowledge.remove',
    documentId: entry.documentId,
    revisionId: updated.revisionId,
  });
  assert.equal((await approve(removal)).status, 'saved');
  assert.deepEqual((await tool({ tool: 'knowledge.list' })).entries, []);
  assert.equal((await tool({ tool: 'knowledge.list', documentId: entry.documentId })).error, 'not-found');
});

test('chat adds a file from Files to Knowledge once', async t => {
  const { tool, approve, files, w } = await setup(t);
  const file = await files.upload(
    w.id,
    w.userId,
    randomUUID(),
    { name: 'faq.md', parentId: null, mediaType: 'text/markdown' },
    Buffer.from('# FAQ'),
  );
  const fileId = file.item?.id ?? file.id;
  assert.equal((await tool({ tool: 'knowledge.add', fileId, text: 'x', title: 'x' })).error, 'invalid-arguments');
  const added = await tool({ tool: 'knowledge.add', fileId });
  const saved = await approve(added);
  assert.equal(saved.status, 'saved');
  const [entry] = (await tool({ tool: 'knowledge.list' })).entries;
  assert.equal(entry.kind, 'file');
  assert.equal(entry.fileId, fileId);
  assert.equal(entry.title, 'faq.md');
  assert.equal((await tool({ tool: 'knowledge.add', fileId })).error, 'already-added');
  assert.equal(
    (await tool({ tool: 'knowledge.update', documentId: entry.documentId, revisionId: entry.revisionId, text: 'x' }))
      .error,
    'invalid-arguments',
  );
  const renamed = await tool({
    tool: 'knowledge.update',
    documentId: entry.documentId,
    revisionId: entry.revisionId,
    title: 'Support FAQ',
  });
  assert.equal((await approve(renamed)).status, 'saved');
  assert.equal((await tool({ tool: 'knowledge.list' })).entries[0].title, 'Support FAQ');
});
