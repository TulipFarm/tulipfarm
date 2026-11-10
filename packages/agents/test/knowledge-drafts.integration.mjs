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
import { AccessDenied, protectedSourceClosure, requireProtectedSource } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createKnowledge, withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';

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
  runtime = withKnowledgeSourceAuthorization(
    createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    }),
  );
  const chats = createConversations(runtime),
    chatId = randomUUID();
  await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  async function reply(text, call, sources = [], fields = {}) {
    const sent = await chats.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Update my Knowledge.' }],
    });
    let output;
    const executor = createConversationExecutor(runtime, async ({ executeTool, messages }) => {
      if (call)
        output = (
          await executeTool(
            call.tool,
            false,
            context => createChatTools(context.runtime).invokeWithSources(context, call),
            sources,
            call,
            fields.activity,
            typeof fields.narration === 'function' ? fields.narration(messages) : fields.narration,
          )
        ).result;
      return { text: typeof text === 'function' ? text(messages) : text, sources };
    });
    await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    return output;
  }
  const tool = call => reply('Review the card.', call);
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
  return { w, db, runtime, chats, chatId, drafts, tool, reply, approve, files: createFiles(runtime, bytes) };
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

for (const change of ['remove note', 'replace note', 'remove file']) {
  test(`${change} preserves unrelated replies and owner-only Knowledge receipts`, async t => {
    const { w, db, runtime, chats, chatId, drafts, tool, reply, approve, files } = await setup(t);
    const text = 'Private source passage: Starter costs $10.';
    const unrelatedText = 'Good morning. This reply predates the Knowledge source.';
    await reply(unrelatedText, { tool: 'tables.definitions' }, [], { narration: 'Reading workspace tables.' });
    let fileId;
    if (change === 'remove file') {
      fileId = randomUUID();
      await files.upload(
        w.id,
        w.userId,
        fileId,
        {
          name: 'private-pricing.md',
          parentId: null,
          mediaType: 'text/markdown',
        },
        Buffer.from(text),
      );
    }
    const added = await tool(
      fileId ? { tool: 'knowledge.add', fileId } : { tool: 'knowledge.add', title: 'Private pricing', text },
    );
    await approve(added);
    const before = await tool({ tool: 'knowledge.add', title: 'Independent draft', text: 'An unrelated note.' });
    const actor = { kind: 'human', membershipId: w.membershipId, userId: w.userId };
    const publicationId = randomUUID();
    await createKnowledge({ runtime }).publishLexical(w.id, actor, {
      id: publicationId,
      documentId: added.documentId,
      revisionId: added.draftId,
      markdown: text,
      pages: 0,
      tokens: 10,
      chunks: [{ heading: '', text, tokens: 10, offset: { kind: 'passage' } }],
    });
    const sourceRow = (
      await db.platform.query(
        `SELECT d.source_id,s.access_epoch FROM "${w.names.schema}".tf_knowledge_documents d
         JOIN "${w.names.schema}".tf_knowledge_sources s ON s.id=d.source_id WHERE d.id=$1`,
        [added.documentId],
      )
    ).rows[0];
    const source = {
      kind: 'knowledge-document',
      workspaceId: w.id,
      sourceId: sourceRow.source_id,
      documentId: added.documentId,
      revisionId: added.draftId,
      publicationId,
      accessEpoch: sourceRow.access_epoch,
    };
    const citedText = `${text} [Pricing](#knowledge-citation=${publicationId}:0)`;
    const dependent = await reply(
      citedText,
      {
        tool: 'knowledge.add',
        title: 'Source-dependent draft',
        text: 'Based on the source.',
      },
      [source],
    );
    // Both cited and uncited reuse expose the model to the earlier source.
    await reply(`See [Pricing](#knowledge-citation=${publicationId}:0).`);
    const copyFromContext = messages => {
      const prior = messages.find(message => message.role === 'assistant' && message.text?.includes(text));
      assert.ok(prior, 'the real executor includes the confidential earlier reply in the model prompt');
      return prior.text.slice(0, text.length);
    };
    await reply(copyFromContext);
    await reply('I checked the table definitions.', { tool: 'tables.definitions' }, [], {
      narration: messages => `Using source: ${copyFromContext(messages)}`,
    });
    const narration = `Using source: ${text}`;
    const narratedStep = (
      await db.platform.query(
        `SELECT c.id,c.turn_id,t.generation,t.attempt_epoch FROM "${w.names.schema}".tf_conversation_tool_calls c
         JOIN "${w.names.schema}".tf_conversation_turns t ON t.id=c.turn_id WHERE c.narration=$1`,
        [narration],
      )
    ).rows[0];
    const streamReference = {
      kind: 'tool',
      turnId: narratedStep.turn_id,
      generation: narratedStep.generation,
      epoch: narratedStep.attempt_epoch,
      id: narratedStep.id,
    };
    assert.equal(await chats.canReadStream(w.id, w.userId, chatId, streamReference), true);
    await db.platform.query(`UPDATE "${w.names.schema}".tf_conversation_turns SET streamed=$2 WHERE id=$1`, [
      narratedStep.turn_id,
      JSON.stringify({
        generation: narratedStep.generation,
        epoch: narratedStep.attempt_epoch,
        text: narration,
        sources: [source],
      }),
    ]);
    const previewReference = { ...streamReference, kind: 'text', step: 0 };
    assert.equal(await chats.canReadStream(w.id, w.userId, chatId, previewReference), true);
    assert.ok(
      (await chats.history(w.id, w.userId, chatId)).messages.some(message =>
        message.tools.some(step => step.id === narratedStep.id && step.narration === narration),
      ),
      'readable source context still permits the original tool narration',
    );
    const legacyText = `Legacy uncited copy: ${text}`;
    const opaqueText = 'An older reply with no recorded tool attribution.';
    let legacySources;
    let followUpMessageId;
    if (change === 'remove note') {
      const scheduled = await tool({ tool: 'followups.schedule', instruction: narration, delayMinutes: 1 });
      assert.equal(scheduled.status, 'scheduled');
      followUpMessageId = scheduled.followUp.id;
      const fired = await chats.send(w.id, w.userId, chatId, {
        messageId: followUpMessageId,
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: narration }],
      });
      await db.platform.query(
        `UPDATE "${w.names.schema}".tf_follow_ups SET status='fired',fired_message_id=$1 WHERE id=$1`,
        [followUpMessageId],
      );
      await createConversationExecutor(runtime, async () => ({
        text: 'The scheduled work is done.',
        sources: [source],
      })).process({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: fired.turnId,
        generation: 0,
      });
      assert.equal(
        (await chats.history(w.id, w.userId, chatId)).messages.find(message => message.id === followUpMessageId)
          .followUp.instruction,
        narration,
      );
      await reply(messages => `Legacy uncited copy: ${copyFromContext(messages)}`, { tool: 'knowledge.list' });
      await reply(opaqueText);
      const old = (
        await db.platform.query(
          `SELECT r.message_id,r.sources FROM "${w.names.schema}".tf_conversation_results r
         JOIN "${w.names.schema}".tf_conversation_parts p ON p.message_id=r.message_id WHERE p.text=$1`,
          [legacyText],
        )
      ).rows[0];
      legacySources = old.sources.map(dependency =>
        dependency.kind === 'private-conversation'
          ? { kind: 'private-conversation', conversationId: chatId }
          : dependency,
      );
      if (!legacySources.some(dependency => dependency.kind === 'knowledge-document')) legacySources.push(source);
      await db.platform.query(`UPDATE "${w.names.schema}".tf_conversation_results SET sources=$2 WHERE message_id=$1`, [
        old.message_id,
        JSON.stringify(legacySources),
      ]);
      await db.platform.query(
        `UPDATE "${w.names.schema}".tf_conversation_results SET sources=$2 WHERE message_id=(
           SELECT message_id FROM "${w.names.schema}".tf_conversation_parts WHERE text=$1)`,
        [opaqueText, JSON.stringify(legacySources)],
      );
    }
    const after = await tool({ tool: 'knowledge.add', title: 'Other entry', text: 'Unrelated content.' });
    await approve(after);
    const changed = await tool(
      change === 'replace note'
        ? {
            tool: 'knowledge.update',
            documentId: added.documentId,
            revisionId: added.draftId,
            text: 'Starter now costs $12.',
          }
        : { tool: 'knowledge.remove', documentId: added.documentId, revisionId: added.draftId },
    );
    const decision = { commandId: randomUUID(), digest: changed.digest, decision: 'save' };
    await drafts.decide(w.id, w.userId, chatId, changed.draftId, decision);

    for (let reload = 0; reload < 2; reload++) {
      const reader = createAuthoringDrafts(runtime);
      for (const [card, operation] of [
        [added, 'add'],
        [after, 'add'],
        [changed, change === 'replace note' ? 'update' : 'remove'],
      ]) {
        const view = await reader.read(w.id, w.userId, chatId, card.draftId);
        assert.equal(view.status, 'saved');
        assert.equal(view.outcome.operation, operation);
        assert.deepEqual(view.proposal, {
          kind: 'knowledge-receipt',
          targetId: card.documentId,
          input: { operation, entry: card === after ? 'note' : fileId ? 'file' : 'note' },
        });
        assert.doesNotMatch(JSON.stringify(view), /Private source passage|Private pricing|private-pricing/);
      }
      assert.equal((await reader.read(w.id, w.userId, chatId, before.draftId)).status, 'pending');
      const history = await createConversations(runtime).history(w.id, w.userId, chatId);
      const texts = history.messages
        .filter(message => message.author === 'assistant')
        .map(message => message.parts.map(part => part.text ?? '').join(''));
      assert.ok(texts.includes(unrelatedText));
      assert.ok(!texts.includes(citedText));
      assert.ok(!texts.includes(`See [Pricing](#knowledge-citation=${publicationId}:0).`));
      const unavailable = texts.filter(value => value.includes('removed or replaced by you'));
      assert.ok(unavailable.length >= 2);
      assert.ok(!texts.includes(opaqueText), 'unattributed legacy dependencies stay withheld');
      assert.doesNotMatch(unavailable.join(''), /access changed|access to it ended|Some work failed/);
    }
    assert.equal(
      (await drafts.decide(w.id, w.userId, chatId, changed.draftId, decision)).operation,
      change === 'replace note' ? 'update' : 'remove',
    );
    if (legacySources) {
      const stored = (
        await db.platform.query(
          `SELECT r.sources FROM "${w.names.schema}".tf_conversation_results r
         JOIN "${w.names.schema}".tf_conversation_parts p ON p.message_id=r.message_id WHERE p.text=$1`,
          [legacyText],
        )
      ).rows[0];
      assert.deepEqual(stored.sources, legacySources, 'legacy reads do not rewrite stored dependencies');
    }
    await t.test('uncited text copied from prior model context is withheld after source removal', async () => {
      const { message_id: messageId } = (
        await db.platform.query(`SELECT message_id FROM "${w.names.schema}".tf_conversation_parts WHERE text=$1`, [
          text,
        ])
      ).rows[0];
      for (let reload = 0; reload < 2; reload++) {
        const history = await createConversations(runtime).history(w.id, w.userId, chatId);
        const withheld = history.messages.find(message => message.id === messageId);
        assert.ok(withheld);
        assert.match(JSON.stringify(withheld.parts), /removed or replaced by you/);
        assert.doesNotMatch(JSON.stringify(withheld.parts), /Private source passage|access changed|Some work failed/);
      }
    });
    await t.test('tool narration cannot retain removed source text across history reloads', async () => {
      for (let reload = 0; reload < 2; reload++) {
        const history = await createConversations(runtime).history(w.id, w.userId, chatId);
        const steps = history.messages.flatMap(message => message.tools);
        const step = steps.find(step => step.id === narratedStep.id);
        assert.ok(step, 'the immutable tool step is not dropped');
        assert.equal(step.tool, 'tables.definitions');
        assert.equal(step.status, 'completed');
        assert.equal(step.narration, null);
        assert.equal(step.presentation.label, 'Used a tool');
        assert.doesNotMatch(JSON.stringify(steps), /Private source passage/);
        assert.ok(steps.some(step => step.narration === 'Reading workspace tables.'));
        assert.equal(await chats.canReadStream(w.id, w.userId, chatId, streamReference), false);
        assert.equal(await chats.canReadStream(w.id, w.userId, chatId, previewReference), false);
      }
    });
    if (followUpMessageId)
      await t.test('generated follow-up instructions use the scheduling step provenance', async () => {
        const message = (await chats.history(w.id, w.userId, chatId)).messages.find(
          message => message.id === followUpMessageId,
        );
        assert.equal(message.followUp.instruction, 'Follow-up unavailable');
        assert.doesNotMatch(JSON.stringify(message), /Private source passage/);
      });
    if (legacySources)
      await t.test('legacy context exposure is not cleared by an unrelated Knowledge list output', async () => {
        const { message_id: messageId } = (
          await db.platform.query(`SELECT message_id FROM "${w.names.schema}".tf_conversation_parts WHERE text=$1`, [
            legacyText,
          ])
        ).rows[0];
        for (let reload = 0; reload < 2; reload++) {
          const history = await createConversations(runtime).history(w.id, w.userId, chatId);
          const withheld = history.messages.find(message => message.id === messageId);
          assert.ok(withheld);
          assert.match(JSON.stringify(withheld.parts), /removed or replaced by you/);
          assert.doesNotMatch(JSON.stringify(withheld.parts), /Private source passage|access changed|Some work failed/);
        }
      });
    await assert.rejects(drafts.read(w.id, w.userId, chatId, dependent.draftId), AccessDenied);
    await reply('A fresh reply after the source changed.');
    assert.ok(
      (await chats.history(w.id, w.userId, chatId)).messages.some(message =>
        message.parts.some(part => part.text === 'A fresh reply after the source changed.'),
      ),
    );
    if (fileId) assert.equal((await files.details(w.id, w.userId, fileId)).item.id, fileId);

    const outsider = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(
      `INSERT INTO "${w.names.schema}".tf_memberships (id,user_id,role) VALUES ($1,$2,'member')`,
      [outsider.membershipId, outsider.userId],
    );
    await assert.rejects(drafts.read(w.id, outsider.userId, chatId, added.draftId), AccessDenied);
    await assert.rejects(chats.history(w.id, outsider.userId, chatId), AccessDenied);
    await assert.rejects(chats.canReadStream(w.id, outsider.userId, chatId, streamReference), AccessDenied);
    await runtime.transaction(w.id, commonCompatibility, async tx => {
      const snapshot = { kind: 'private-conversation', conversationId: chatId, snapshot: true };
      assert.deepEqual(await protectedSourceClosure(tx, [snapshot]), [snapshot]);
      await requireProtectedSource(tx, actor, snapshot);
      await assert.rejects(requireProtectedSource(tx, { kind: 'human', ...outsider }, snapshot), AccessDenied);
    });
    await db.platform.query(`UPDATE "${w.names.schema}".tf_memberships SET removed_at=clock_timestamp() WHERE id=$1`, [
      w.membershipId,
    ]);
    await assert.rejects(drafts.read(w.id, w.userId, chatId, changed.draftId), AccessDenied);
    await assert.rejects(chats.history(w.id, w.userId, chatId), AccessDenied);
    await assert.rejects(chats.canReadStream(w.id, w.userId, chatId, streamReference), AccessDenied);
  });
}
