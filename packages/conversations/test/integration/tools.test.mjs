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
        // The reclaimed attempt cannot resume after a tool call, so it stops with the crash cause instead of answering.
        assert.equal(await executor.complete(reclaimed), 'stale');
        assert.equal(
          (
            await f.db.platform.query(`SELECT error_code FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
              sent.turnId,
            ])
          ).rows[0].error_code,
          'reply-interrupted',
        );
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
      assert.ok(Array.isArray(result.tables));
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
    assert.equal(await executor.process({ ...work, generation: 1 }), 'stale');
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
    // The stop carries the failed attempt's cause instead of a canned tool dump.
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].turn.status, 'failed');
    assert.equal(history.messages[0].turn.errorCode, 'transient-failure');
    assert.equal(JSON.stringify(history).includes('did not repeat'), false);
    assert.equal(JSON.stringify(history).includes('Discover resources first'), false);
    const retried = await f.store.retry(w.id, w.userId, chatId, sent.turnId, {
      commandId: randomUUID(),
      expectedGeneration: history.messages[0].turn.generation,
    });
    let resumed;
    const resume = createConversationExecutor(f.runtime, async input => {
      resumed = input;
      return 'Continued from the completed tools.';
    });
    assert.equal(await resume.process({ ...work, generation: retried.generation }), 'completed');
    assert.equal(calls, 1);
    assert.equal(resumed.priorCalls, 2);
    for (const tool of ['tables.definitions', 'skills.read'])
      assert.ok(
        resumed.messages.some(message => message.text.includes(`for ${tool} (completed). Do not repeat this call.`)),
      );
    const continued = await f.store.history(w.id, w.userId, chatId);
    assert.equal(continued.messages[0].turn.status, 'completed');
    assert.equal(continued.messages[0].tools.length, 2);
    assert.equal(continued.messages[1].parts[0].text, 'Continued from the completed tools.');
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

test('competing deliveries of one reply execute its tool once', async () => {
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
    let operations = 0;
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool('skills.list', false, async () => {
        operations++;
        return { skills: [] };
      });
      return 'Done';
    });
    // Tool receipts take the turn's next free sequence, so the claim lease, not the sequence, admits one delivery.
    const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    const results = await Promise.all([executor.process(work), executor.process(work)]);
    assert.equal(operations, 1);
    assert.deepEqual(results.toSorted(), ['completed', 'idle']);
    assert.equal((await f.store.history(w.id, w.userId, chatId)).messages[0].tools.length, 1);
  } finally {
    await f.close();
  }
});

test('a reply stopped after tools keeps the failed attempt cause instead of a tool dump', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Read the procedure' }],
    });
    const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool('skills.read', false, context =>
        createChatTools(context.runtime).invoke(context, { tool: 'skills.read', skillId: 'table-authoring' }),
      );
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    });
    assert.equal(await executor.process(work), 'retry');
    assert.equal(
      (
        await f.db.platform.query(`SELECT error_code FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
          sent.turnId,
        ])
      ).rows[0].error_code,
      'database-conflict',
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [sent.turnId],
    );
    assert.equal(await executor.process({ ...work, generation: 1 }), 'stale');
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].turn.status, 'failed');
    assert.equal(history.messages[0].turn.errorCode, 'database-conflict');
    assert.deepEqual(
      history.messages[0].tools.map(({ tool, status }) => [tool, status]),
      [['skills.read', 'completed']],
    );
    assert.equal(JSON.stringify(history).includes('interrupted'), false);
  } finally {
    await f.close();
  }
});
