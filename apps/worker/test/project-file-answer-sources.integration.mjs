import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFiles } from '@tulipfarm/files';
import { withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversations } from '../../../packages/conversations/src/index.ts';
import { createProjects } from '../../../packages/conversations/src/projects.ts';
import { completionReply, isCompletionRequest, anthropicText, isTitleRequest } from './native-chat-fixture.mjs';
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

// Project context reaches the model without a tool call, so the saved answer must carry its source File for later project members.
test('a project answer from a File passage depends on that File', { timeout: 120000 }, async t => {
  const f = await conversationFixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelCatalog());
  try {
    const w = f.workspace,
      reader = { userId: randomUUID(), membershipId: randomUUID() },
      later = { userId: randomUUID(), membershipId: randomUUID() };
    for (const member of [reader, later])
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        member.membershipId,
        member.userId,
      ]);
    const objects = new Map();
    const files = createFiles(f.runtime, {
      putIfAbsent: async (key, body) => {
        objects.set(key, Buffer.from(body));
      },
      read: async key => objects.get(key),
      remove: async key => {
        objects.delete(key);
      },
    });
    const store = createConversations(withKnowledgeSourceAuthorization(f.runtime));
    const projects = createProjects(f.runtime, undefined, files);

    const sentinel = `file-only-${randomUUID()}`,
      fileId = randomUUID(),
      projectId = randomUUID();
    await files.upload(
      w.id,
      w.userId,
      fileId,
      { name: 'Vendor code.txt', parentId: null, mediaType: 'text/plain' },
      Buffer.from(`The vendor code is ${sentinel}.`),
    );
    await files.share(w.id, w.userId, fileId, { kind: 'individual', id: reader.membershipId }, 'viewer');
    await projects.create(w.id, w.userId, { id: projectId, name: 'Operations' });
    await projects.member(w.id, w.userId, projectId, {
      membershipId: reader.membershipId,
      role: 'member',
      removed: false,
    });
    const added = await projects.addFile(w.id, w.userId, projectId, { fileId, commandId: randomUUID() });
    await projects.knowledgeState(w.id, w.userId, projectId, added.id, { pinned: true, removed: false });

    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Vendor code'));
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      return streamed(`Your vendor code is ${JSON.stringify(body.messages).match(/file-only-[0-9a-f-]{36}/)?.[0]}.`);
    });
    const chatId = randomUUID();
    await store.create(w.id, w.userId, { chatId, commandId: randomUUID(), projectId });
    const sent = await store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'What is our vendor code?' }],
    });
    assert.equal(
      await createConversationActivities(f.runtime, undefined, undefined, null, files).processConversationReply({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: 0,
      }),
      'completed',
    );

    const [result] = (
      await f.db.platform.query(
        `SELECT r.sources FROM ${f.table('tf_conversation_results')} r JOIN ${f.table('tf_conversation_messages')} m ON m.id=r.message_id WHERE m.conversation_id=$1`,
        [chatId],
      )
    ).rows;
    assert.ok(
      result.sources.some(source => source.kind === 'tulipfarm-file' && source.fileId === fileId),
      'the saved answer depends on the project File',
    );
    const answer = async userId => (await store.history(w.id, userId, chatId)).messages.at(-1).parts[0].text;
    assert.equal(
      await answer(reader.userId),
      `Your vendor code is ${sentinel}.`,
      'a project member who can read the File sees the answer',
    );

    await projects.member(w.id, w.userId, projectId, {
      membershipId: later.membershipId,
      role: 'member',
      removed: false,
    });
    await assert.rejects(files.read(w.id, later.userId, fileId), /not found/i);
    assert.doesNotMatch(
      JSON.stringify(await store.history(w.id, later.userId, chatId)),
      new RegExp(sentinel),
      'a later member without File access cannot read the answer',
    );
  } finally {
    await f.close();
  }
});
