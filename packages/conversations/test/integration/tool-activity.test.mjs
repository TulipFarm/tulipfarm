import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../fixture.mjs';
import { createConversationExecutor } from '../../src/runtime.ts';
import { storedToolPresentation } from '../../src/tool-activity-history.ts';
import { commonCompatibility } from '../../../workspaces/src/storage.ts';

test('local tools publish running receipts before execution', async () => {
  const f = await conversationFixture();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let work;
  try {
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'List resources' }],
    });
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool(
        'tables.definitions',
        false,
        async () => {
          entered.resolve();
          await release.promise;
          return { tables: [] };
        },
        [],
        { tool: 'tables.definitions' },
        'Private invented model text',
      );
      return 'Done';
    });
    work = executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    await entered.promise;
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.deepEqual(
      history.messages[0].tools.map(tool => [tool.status, tool.presentation]),
      [['running', { label: 'Listing business tables', brand: null }]],
    );
    assert.equal(JSON.stringify(history).includes('Private invented model text'), false);
    release.resolve();
    assert.equal(await work, 'completed');
    assert.equal((await f.store.history(w.id, w.userId, chatId)).messages[0].tools[0].status, 'completed');
  } finally {
    release.resolve();
    await work;
    await f.close();
  }
});

test('Google execution and status resolve the approved operation without exposing its payload', async () => {
  const { googleFixture } = await import('../../../google-workspace/test/fixture.mjs');
  const { createGoogleOperations } = await import('../../../google-workspace/src/operations.ts');
  const f = await googleFixture();
  try {
    await f.connect();
    const proposal = await createGoogleOperations({ runtime: f.runtime, integrations: f.service }).propose(
      f.workspace.id,
      f.member.userId,
      { commandId: randomUUID(), operation: { kind: 'gmail.messages.trash', messageId: 'private-message-id' } },
    );
    for (const tool of ['google.execute', 'google.status']) {
      const value = await f.runtime.transaction(
        f.workspace.id,
        { minimum: 1, maximum: commonCompatibility.maximum },
        tx => storedToolPresentation(tx, f.member, tool, { tool, proposalId: proposal.id }),
      );
      assert.equal(value.brand, 'gmail');
      assert.equal(
        value.label,
        `${tool === 'google.execute' ? 'Executing approved action' : 'Checking approval and outcome'}: Move a Gmail message to trash`,
      );
      assert.equal(JSON.stringify(value).includes('private-message-id'), false);
    }
  } finally {
    await f.close();
  }
});
