import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

test('history reports GitHub proposals across pages and only for the owned chat', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const chatId = randomUUID(),
      otherChatId = randomUUID();
    for (const id of [chatId, otherChatId])
      await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
    assert.equal((await f.store.history(w.id, w.userId, chatId)).hasGitHubProposals, false);
    const first = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Prepare a GitHub issue.' }],
    });
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool('github.personal.propose', false, async () => ({ id: randomUUID() }));
      return 'Review the proposed issue.';
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: first.turnId, generation: 0 }),
      'completed',
    );
    assert.equal((await f.store.history(w.id, w.userId, chatId)).hasGitHubProposals, true);
    for (let index = 0; index < 51; index++)
      await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: `Later message ${index}` }],
      });
    const latest = await f.store.history(w.id, w.userId, chatId);
    assert.equal(latest.hasGitHubProposals, true);
    assert.equal(latest.messages.length, 50);
    assert.equal(
      latest.messages.some(message => message.tools.some(tool => tool.tool === 'github.personal.propose')),
      false,
    );
    assert.equal(latest.nextBefore, 4);
    const older = await f.store.history(w.id, w.userId, chatId, { before: latest.nextBefore });
    assert.equal(older.hasGitHubProposals, true);
    assert.equal(older.messages[0].tools[0].tool, 'github.personal.propose');
    assert.equal((await f.store.history(w.id, w.userId, otherChatId)).hasGitHubProposals, false);
    await assert.rejects(f.store.history(w.id, randomUUID(), chatId));
  } finally {
    await f.close();
  }
});
