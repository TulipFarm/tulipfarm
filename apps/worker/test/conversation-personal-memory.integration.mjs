import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPersonalMemoryService } from '@tulipfarm/conversations/personal-memory';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { completionReply, isCompletionRequest, anthropicText, isTitleRequest } from './native-chat-fixture.mjs';
import { useModelFamilies } from './model-families-fixture.mjs';

test('default worker composition includes current personal memory across private chats and omits deleted memory', async t => {
  const f = await conversationFixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelFamilies());
  try {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Preferences'));
      requests.push(body);
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      return Response.json(anthropicText('Here is the answer.'));
    });
    const w = f.workspace;
    const memory = createPersonalMemoryService(f.runtime);
    await memory.save(w.id, w.userId, { content: 'Prefer concise bullet points.', expectedRevision: 0 });
    for (let index = 0; index < 3; index++) {
      if (index === 2) await memory.delete(w.id, w.userId, { expectedRevision: 1 });
      const chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text: 'Hello.' }],
      });
      assert.equal(
        await createConversationActivities(f.runtime).processConversationReply({
          workspaceId: w.id,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: 0,
        }),
        'completed',
      );
      const input = JSON.stringify(requests.at(-2).messages);
      if (index < 2) assert.match(input, /Prefer concise bullet points/);
      else assert.doesNotMatch(input, /Prefer concise bullet points|personalMemory/);
      const history = await f.store.history(w.id, w.userId, chatId);
      assert.equal(history.messages[1].parts[0].text, 'Here is the answer.');
    }
    assert.equal(requests.length, 6);
  } finally {
    await f.close();
  }
});
