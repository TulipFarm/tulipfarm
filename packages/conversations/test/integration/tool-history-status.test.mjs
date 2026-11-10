import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

const webResult = {
  kind: 'public-web',
  status: 'success',
  sources: [{ url: 'https://example.com/report', title: 'Quarterly report', description: '', publishedAt: null }],
  pages: [],
  window: 'any',
  widened: false,
  retrievedAt: new Date().toISOString(),
  untrusted: true,
};
const knowledgeResult = {
  provider: 'knowledge',
  action: 'search',
  branches: [
    {
      index: 0,
      status: 'evidence',
      reason: null,
      documents: [
        { title: 'Pricing policy', completeness: 'complete', omitted: false, passages: [{ truncated: false }] },
      ],
    },
  ],
};

test('opaque prior context preserves tool status but conceals model-written details in history', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const send = async text =>
      f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text }],
      });
    const first = await send('Hello');
    const answer = createConversationExecutor(f.runtime, async () => 'Hello back.');
    assert.equal(
      await answer.process({ workspaceId: w.id, conversationId: chatId, turnId: first.turnId, generation: 0 }),
      'completed',
    );
    const second = await send('Research our pricing');
    const research = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool('knowledge.retrieve', false, async () => ({ result: knowledgeResult, sources: [] }), [], {
        tool: 'knowledge.retrieve',
        action: 'search',
        queries: ['pricing'],
      });
      await executeTool('web.search', true, async () => ({ result: webResult, sources: [] }), [], {
        tool: 'web.search',
        query: 'competitor pricing',
        window: 'any',
        limit: 5,
      });
      await executeTool(
        'web.fetch',
        true,
        async () => ({
          result: { ...webResult, pages: [{ ...webResult.sources[0], status: 'read', text: 'Body' }] },
          sources: [],
        }),
        [],
        { tool: 'web.fetch', url: 'https://example.com/report' },
      );
      return { text: 'Pricing summary.', sources: [] };
    });
    assert.equal(
      await research.process({ workspaceId: w.id, conversationId: chatId, turnId: second.turnId, generation: 0 }),
      'completed',
    );
    const retained = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_execution_steps')} WHERE turn_id=$1`, [
        second.turnId,
      ])
    ).rows;
    assert.ok(
      retained.every(row => row.sources.some(source => source.kind === 'unknown')),
      'receipts retain the earlier answer of unknown provenance',
    );
    const history = async () =>
      (await f.store.history(w.id, w.userId, chatId)).messages.find(message => message.turn?.id === second.turnId)
        .tools;
    const tools = await history();
    assert.deepEqual(
      tools.map(tool => [tool.tool, tool.status]),
      [
        ['knowledge.retrieve', 'completed'],
        ['web.search', 'completed'],
        ['web.fetch', 'completed'],
      ],
    );
    for (const tool of tools) {
      assert.deepEqual(tool.presentation, { label: 'Used a tool', brand: null });
      assert.equal(tool.narration, null);
      assert.equal(tool.web, null);
      assert.equal(tool.knowledge, undefined);
    }
    await f.db.platform.query(`UPDATE ${f.table('tf_conversation_execution_steps')} SET sources=$2 WHERE turn_id=$1`, [
      second.turnId,
      JSON.stringify([{ kind: 'personal-memory', membershipId: w.membershipId }]),
    ]);
    const own = await history();
    assert.equal(own[0].knowledge.status, 'success');
    assert.equal(own[0].knowledge.branches.length, 1);
    assert.equal(own[1].web.status, 'success');
    assert.equal(own[1].web.query, 'competitor pricing');
    assert.equal(own[2].web.status, 'success');
    assert.deepEqual(own[2].web.urls, ['https://example.com/report']);
  } finally {
    await f.close();
  }
});

test('expected table proposal answers show their reason, and only real errors show as failed', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Archive the table, then add another one' }],
    });
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      const propose = (run, input = '{}') =>
        executeTool('tables.propose', false, run, [], { tool: 'tables.propose', input }).catch(() => undefined);
      const answer = result => propose(async () => ({ result: { ...result, instruction: 'x' }, sources: [] }));
      await answer({ error: 'workflow-active', workflows: [{ id: randomUUID(), name: 'Daily sync' }] });
      await answer({ error: 'table-linked' });
      await answer({ error: 'invalid-transform' });
      await answer({ error: 'import-not-prepared' });
      await propose(async () => {
        throw new Error('storage unavailable');
      });
      await answer({ error: 'invalid-arguments' });
      await propose(
        async () => {
          throw new AccessDenied();
        },
        JSON.stringify({ plans: [{ kind: 'schema', expectedRevision: null }] }),
      );
      await answer({ error: 'invalid-arguments' });
      return 'The workflow Daily sync uses this table.';
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    const tools = (await f.store.history(w.id, w.userId, chatId)).messages[0].tools;
    assert.deepEqual(
      tools.map(tool => [tool.activityStatus, tool.activityDetail ?? null]),
      [
        ['completed', 'Not archived: an active workflow uses this table.'],
        ['completed', 'Not archived: another table links to this table.'],
        ['completed', 'No review prepared: some row values don’t fit the changed fields.'],
        ['completed', 'No review prepared: the file wasn’t read first.'],
        ['failed', null],
        ['completed', 'Corrected and resubmitted.'],
        [
          'blocked',
          'Access denied. Adding this table needs Create tables for its owning team. Ask a workspace admin to grant it to you or your team in Table access, then ask again.',
        ],
        ['completed', 'No review prepared: the request wasn’t valid.'],
      ],
    );
  } finally {
    await f.close();
  }
});
