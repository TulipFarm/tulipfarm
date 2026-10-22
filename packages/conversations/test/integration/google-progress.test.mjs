import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { googleFixture } from '../../../google-workspace/test/fixture.mjs';
import { createGoogleOperations } from '../../../google-workspace/src/operations.ts';
import { createChatTools } from '../../../agents/src/tools.ts';
import { createConversationExecutor } from '../../src/runtime.ts';

test('history exposes a running Gmail operation before the provider responds', { timeout: 30000 }, async () => {
  const f = await googleFixture();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let work;
  try {
    await f.connect();
    const chatId = randomUUID();
    await f.store.create(f.workspace.id, f.member.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(f.workspace.id, f.member.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Show my emails' }],
    });
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      for (const operation of [
        { kind: 'gmail.messages.list' },
        { kind: 'gmail.messages.get', messageId: 'private-id' },
      ]) {
        const call = { tool: 'google.read', operation };
        await executeTool(
          call.tool,
          true,
          context =>
            createChatTools(context.runtime, {
              google: runtime =>
                createGoogleOperations({
                  runtime,
                  integrations: f.service,
                  fetcher: async () => {
                    if (operation.kind === 'gmail.messages.get') {
                      entered.resolve();
                      await release.promise;
                    }
                    return Response.json({ messages: [{ id: 'private-id' }] });
                  },
                }),
            }).invokeWithSources(context, call),
          [],
          call,
          'Private email subject',
        );
      }
      return { text: 'Emails read.', sources: [] };
    });
    work = executor.process({
      workspaceId: f.workspace.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
    await entered.promise;
    const history = await Promise.race([
      f.store.history(f.workspace.id, f.member.userId, chatId),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('History blocked on the provider operation')), 2000);
        timer.unref();
      }),
    ]);
    assert.deepEqual(
      history.messages[0].tools.map(({ status, activity }) => [status, activity]),
      [
        ['completed', 'Reading your Gmail data'],
        ['running', 'Reading your Gmail data'],
      ],
    );
    assert.equal(JSON.stringify(history).includes('Private email subject'), false);
    release.resolve();
    assert.equal(await work, 'completed');
    const completed = await f.store.history(f.workspace.id, f.member.userId, chatId);
    assert.deepEqual(
      completed.messages[0].tools.map(tool => tool.status),
      ['completed', 'completed'],
    );
  } finally {
    release.resolve();
    await work;
    await f.close();
  }
});
