import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
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

// Each later tool receipt retains the reply's earlier context, including markers such as an earlier answer of unknown provenance.
// Those markers are not the row's own sources, so a tool that succeeded must not reload as failed or unavailable.
test('tools that succeeded in a follow-up turn keep their outcome in history', async () => {
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
    assert.equal(tools[0].knowledge.status, 'success');
    assert.deepEqual(tools[0].knowledge.branches, [], 'opaque provenance conceals details, not the outcome');
    assert.deepEqual(tools[1].web, { status: 'success', urls: [], failedUrls: [], widened: false });
    assert.deepEqual(tools[2].web, { status: 'success', urls: [], failedUrls: [], widened: false });
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
