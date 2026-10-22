import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createFiles } from '@tulipfarm/files';
import { createKnowledge, createLocalKnowledge, withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { createKnowledgeTools } from '../src/knowledge-tools-composition.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversations } from '../../../packages/conversations/src/index.ts';
import { createProjects } from '../../../packages/conversations/src/projects.ts';
import { conversationEventChannel } from '../../../packages/conversations/src/events.ts';
import {
  completionReply,
  isCompletionRequest,
  anthropicChat,
  anthropicText,
  isTitleRequest,
  toolResults,
} from './native-chat-fixture.mjs';
import { useModelCatalog } from './model-catalog-fixture.mjs';

const usage = { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const streamed = text =>
  new Response(
    [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'synthetic',
          content: [],
          stop_reason: null,
          usage,
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]
      .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

// Streamed previews reach every chat subscriber before the saved answer's project audience check, so project chats must not stream answer text.
test('project chats stream no answer text from sources other members cannot read', { timeout: 120000 }, async t => {
  const f = await conversationFixture();
  const listener = new pg.Client({ connectionString: f.db.connectionString });
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelCatalog());
  try {
    const w = f.workspace,
      member = { userId: randomUUID(), membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member.membershipId,
      member.userId,
    ]);
    const store = createConversations(withKnowledgeSourceAuthorization(f.runtime));
    const sentinel = `owner-only-${randomUUID()}`,
      text = `The vendor code is ${sentinel}.`;
    const local = createLocalKnowledge({
      runtime: f.runtime,
      files: createFiles(f.runtime, { putIfAbsent: async () => {}, read: async () => Buffer.from(text) }),
    });
    const note = await local.save(w.id, w.userId, {
      commandId: randomUUID(),
      documentId: randomUUID(),
      expectedRevisionId: null,
      title: 'Vendor codes',
      input: { kind: 'note', text },
    });
    // Publishes the parsed note directly so the test does not depend on the parser child process.
    await createKnowledge({ runtime: f.runtime }).publishLexical(
      w.id,
      { kind: 'human', userId: w.userId, membershipId: w.membershipId },
      {
        id: randomUUID(),
        documentId: note.documentId,
        revisionId: note.revisionId,
        markdown: `${text}\n`,
        pages: 0,
        tokens: 8,
        chunks: [{ heading: '', text, tokens: 8, offset: { kind: 'passage' } }],
      },
    );
    await assert.rejects(local.get(w.id, member.userId, note.documentId), /not found/i);

    const projectId = randomUUID(),
      projects = createProjects(f.runtime);
    await projects.create(w.id, w.userId, { id: projectId, name: 'Operations' });
    await projects.member(w.id, w.userId, projectId, {
      membershipId: member.membershipId,
      role: 'member',
      removed: false,
    });

    const received = [];
    await listener.connect();
    listener.on('notification', message => {
      if (message.channel === conversationEventChannel) received.push(JSON.parse(message.payload));
    });
    await listener.query(`LISTEN ${conversationEventChannel}`);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Vendor code'));
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      const results = toolResults(body);
      if (!results.length)
        return Response.json(anthropicChat({ kind: 'tool', call: { tool: 'knowledge.search', query: 'vendor code' } }));
      return streamed(`Your vendor code is ${JSON.stringify(results).match(/owner-only-[0-9a-f-]{36}/)?.[0]}.`);
    });
    const knowledge = createKnowledgeTools({ runtime: f.runtime, env: {} });
    async function ask(projectId) {
      const chatId = randomUUID();
      await store.create(w.id, w.userId, { chatId, commandId: randomUUID(), ...(projectId ? { projectId } : {}) });
      const sent = await store.send(w.id, w.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text: 'What is our vendor code?' }],
      });
      assert.equal(
        await createConversationActivities(
          f.runtime,
          undefined,
          undefined,
          null,
          undefined,
          knowledge,
        ).processConversationReply({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      for (
        let wait = 0;
        wait < 100 && !received.some(item => item.conversationId === chatId && item.kind === 'changed' && item.settled);
        wait++
      )
        await delay(20);
      const answer = (await store.history(w.id, w.userId, chatId)).messages.at(-1).parts[0].text;
      return {
        answer,
        texts: received.filter(item => item.conversationId === chatId && item.kind === 'text').map(item => item.text),
      };
    }

    const project = await ask(projectId);
    assert.deepEqual(project.texts, []);
    assert.match(project.answer, /some project members cannot see/);
    assert.ok(
      received.some(item => item.kind === 'progress'),
      'project chats still publish progress',
    );

    const personal = await ask();
    assert.ok(
      personal.texts.some(value => value.includes(sentinel)),
      'private chats still stream answer text',
    );
    assert.equal(personal.answer, `Your vendor code is ${sentinel}.`);
  } finally {
    await listener.end().catch(() => {});
    await f.close();
  }
});
