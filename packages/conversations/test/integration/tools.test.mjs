import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createChatTools } from '../../../agents/src/tools.ts';
import { conversationFixture } from '../fixture.mjs';

for (const interruption of ['cancel', 'reclaim', 'membership'])
  test(`external receipts terminalize on ${interruption} and stale completion cannot overwrite them`, async () => {
    const f = await conversationFixture();
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    let entered;
    const started = new Promise(resolve => {
      entered = resolve;
    });
    let work;
    try {
      const w = f.workspace,
        chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Read public text' }],
      });
      const ids = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
        await executeTool('skills.list', false, async () => ({ skills: [] }));
        await executeTool('web.fetch', true, async () => {
          entered();
          await gate;
          return { text: 'Late result' };
        });
        return 'Late answer';
      });
      work = executor.process(ids);
      await started;
      const statuses = async () =>
        (
          await f.db.platform.query(
            `SELECT tool, status FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id = $1 ORDER BY sequence`,
            [sent.turnId],
          )
        ).rows;
      assert.deepEqual(await statuses(), [
        { tool: 'skills.list', status: 'completed' },
        { tool: 'web.fetch', status: 'running' },
      ]);
      if (interruption === 'cancel')
        await f.store.cancel(w.id, w.userId, chatId, sent.turnId, { commandId: randomUUID(), expectedGeneration: 0 });
      if (interruption === 'reclaim') {
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_turns')} SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`,
          [sent.turnId],
        );
        const reclaimed = await executor.claim(ids);
        assert.equal(reclaimed.epoch, 2);
        assert.deepEqual(await statuses(), [
          { tool: 'skills.list', status: 'completed' },
          { tool: 'web.fetch', status: 'failed' },
        ]);
        assert.equal(await executor.complete(reclaimed), 'completed');
      }
      if (interruption === 'membership') {
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
          w.membershipId,
        ]);
        assert.equal(await executor.claim(ids), null);
      }
      const expected = [
        { tool: 'skills.list', status: 'completed' },
        { tool: 'web.fetch', status: interruption === 'membership' ? 'blocked' : 'failed' },
      ];
      assert.deepEqual(await statuses(), expected);
      release();
      assert.equal(await work, 'stale');
      assert.deepEqual(await statuses(), expected);
    } finally {
      release();
      await work;
      await f.close();
    }
  });

test('chat executes authorized tools, persists safe receipts, and never replays after a lost answer', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'List my resources' }],
    });
    const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    let calls = 0;
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      calls++;
      const result = await executeTool(
        'tables.definitions',
        false,
        context => createChatTools(context.runtime).invoke(context, { tool: 'tables.definitions', limit: 25 }),
        [],
        undefined,
        '  Listing your\n business records  ',
      );
      assert.deepEqual(result.tables, []);
      const skill = await executeTool('skills.read', false, context =>
        createChatTools(context.runtime).invoke(context, { tool: 'skills.read', skillId: 'table-authoring' }),
      );
      assert.equal(skill.name, 'Propose business records for review');
      throw new Error('lost model answer');
    });
    assert.equal(await executor.process(work), 'retry');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET retry_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [sent.turnId],
    );
    assert.equal(await executor.process({ ...work, generation: 1 }), 'completed');
    assert.equal(calls, 1);
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.deepEqual(
      history.messages[0].tools.map(({ tool, status }) => ({ tool, status })),
      [
        { tool: 'tables.definitions', status: 'completed' },
        { tool: 'skills.read', status: 'completed' },
      ],
    );
    assert.deepEqual(
      history.messages[0].tools.map(({ activity }) => activity),
      ['Listing business tables', 'Reading a procedure'],
    );
    assert.match(history.messages[1].parts[0].text, /did not repeat/);
    assert.equal(JSON.stringify(history).includes('Discover resources first'), false);
  } finally {
    await f.close();
  }
});

test('cancellation fences a subsequent tool and hides raw failures from history', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Inspect a resource' }],
    });
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await f.store.cancel(w.id, w.userId, chatId, sent.turnId, { commandId: randomUUID(), expectedGeneration: 0 });
      await executeTool('schema.inspect', false, async () => {
        throw new Error('operation must not execute');
      });
      return 'not published';
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'stale',
    );
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.deepEqual(
      history.messages.map(message => [message.turn.status, message.tools]),
      [['cancelled', []]],
    );
  } finally {
    await f.close();
  }
});

test('competing completions cannot both execute a tool at the same sequence', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Run once' }],
    });
    let arrivals = 0,
      operations = 0;
    let release;
    const ready = new Promise(resolve => {
      release = resolve;
    });
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      if (++arrivals === 2) release();
      await ready;
      await executeTool('skills.list', false, async () => {
        operations++;
        return { skills: [] };
      });
      return 'Done';
    });
    const fence = await executor.claim({
      workspaceId: w.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
    const results = await Promise.allSettled([executor.complete(fence), executor.complete(fence)]);
    assert.equal(operations, 1);
    assert.equal(results.filter(result => result.status === 'fulfilled' && result.value === 'completed').length, 1);
    assert.equal((await f.store.history(w.id, w.userId, chatId)).messages[0].tools.length, 1);
  } finally {
    await f.close();
  }
});
