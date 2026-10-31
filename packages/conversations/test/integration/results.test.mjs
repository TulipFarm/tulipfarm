import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../fixture.mjs';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createConversationRequests } from '../../src/requests.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

async function send(f, chatId, text = 'Continue') {
  const turn = await f.store.send(f.workspace.id, f.workspace.userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text }],
  });
  return { workspaceId: f.workspace.id, conversationId: chatId, turnId: turn.turnId, generation: 0 };
}
const results = async f =>
  (
    await f.db.platform.query(
      `SELECT turn_id, sources, publication FROM ${f.table('tf_conversation_results')} ORDER BY created_at`,
    )
  ).rows;

test('queued B inherits completed A lineage despite physical message order, without another chat or later C', async () => {
  const f = await conversationFixture();
  try {
    const chatId = randomUUID(),
      otherId = randomUUID();
    const tableId = randomUUID(),
      otherTableId = randomUUID();
    for (const id of [chatId, otherId])
      await f.store.create(f.workspace.id, f.workspace.userId, { chatId: id, commandId: randomUUID() });
    const other = await send(f, otherId, 'Other request');
    assert.equal(
      await createConversationExecutor(f.runtime, async () => ({
        text: 'Other answer',
        sources: [{ kind: 'table', tableId: otherTableId }],
      })).process(other),
      'completed',
    );
    const calls = [];
    const executor = createConversationExecutor(f.runtime, async ({ messages }) => {
      calls.push(messages);
      return messages.at(-1).text === 'A'
        ? { text: 'A answer', sources: [{ kind: 'table', tableId }] }
        : { text: 'B summary', sources: [] };
    });
    const a = await send(f, chatId, 'A');
    const fence = await executor.claim(a);
    const b = await send(f, chatId, 'B');
    const c = await send(f, chatId, 'C');
    assert.equal(await executor.claim(b), null);
    assert.equal(await executor.complete(fence), 'completed');
    assert.equal(await executor.process(b), 'completed');
    assert.deepEqual(calls, [
      [{ role: 'user', text: 'A' }],
      [
        { role: 'user', text: 'A' },
        { role: 'assistant', text: 'A answer' },
        { role: 'user', text: 'B' },
      ],
    ]);
    const expected = [
      { kind: 'private-conversation', conversationId: chatId },
      { kind: 'table', tableId },
    ];
    assert.deepEqual(
      (await results(f)).filter(row => row.turn_id !== other.turnId),
      [
        { turn_id: a.turnId, sources: expected, publication: 'private' },
        { turn_id: b.turnId, sources: expected, publication: 'private' },
      ],
    );
    assert.deepEqual(
      (await f.store.history(f.workspace.id, f.workspace.userId, chatId)).messages.map(
        message => message.parts[0].text,
      ),
      ['A', 'B', 'C', 'A answer', 'B summary'],
    );
    assert.deepEqual(
      (await executor.due(f.workspace.id)).filter(work => work.conversationId === chatId),
      [c],
    );
  } finally {
    await f.close();
  }
});

test('answers persist lineage atomically, inherit sources after runtime restart, and cannot be rewritten by the runtime login', async () => {
  const f = await conversationFixture();
  let restarted;
  try {
    const chatId = randomUUID(),
      tableId = randomUUID();
    await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
    const work = await send(f, chatId);
    const executor = createConversationExecutor(f.runtime, async () => ({
      text: 'Private records',
      sources: [
        { kind: 'table', tableId },
        { kind: 'table', tableId },
      ],
    }));
    assert.equal(await executor.process(work), 'completed');
    assert.equal(await executor.process(work), 'idle');
    const expected = [
      { kind: 'private-conversation', conversationId: chatId },
      { kind: 'table', tableId },
    ];
    assert.deepEqual(await results(f), [{ turn_id: work.turnId, sources: expected, publication: 'private' }]);
    restarted = f.createRuntime();
    const next = await send(f, chatId);
    assert.equal(
      await createConversationExecutor(restarted, async () => ({ text: 'Summary', sources: [] })).process(next),
      'completed',
    );
    assert.deepEqual((await results(f))[1], { turn_id: next.turnId, sources: expected, publication: 'private' });
    assert.deepEqual(
      (await f.store.history(f.workspace.id, f.workspace.userId, chatId)).messages
        .filter(m => m.author === 'assistant')
        .map(m => m.parts[0].text),
      ['Private records', 'Summary'],
    );
    for (const sql of [
      `UPDATE ${f.table('tf_conversation_results')} SET sources='[]'`,
      `DELETE FROM ${f.table('tf_conversation_results')}`,
    ]) {
      await assert.rejects(
        f.runtime.transaction(f.workspace.id, commonCompatibility, tx => tx.client.query(sql)),
        error => error.code === '42501',
      );
    }
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('cancelled and malformed replies publish neither an answer nor a source receipt', async () => {
  const f = await conversationFixture();
  try {
    const chatId = randomUUID();
    await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
    const work = await send(f, chatId);
    const cancelled = createConversationExecutor(f.runtime, async () => {
      await f.store.cancel(f.workspace.id, f.workspace.userId, chatId, work.turnId, {
        commandId: randomUUID(),
        expectedGeneration: 0,
      });
      return { text: 'Must not publish', sources: [] };
    });
    assert.equal(await cancelled.process(work), 'stale');
    assert.deepEqual(await results(f), []);
    const next = await send(f, chatId);
    assert.equal(
      await createConversationExecutor(f.runtime, async () => ({
        text: 'Invalid',
        sources: [{ kind: 'public' }],
      })).process(next),
      'retry',
    );
    assert.deepEqual(await results(f), []);
    const history = await f.store.history(f.workspace.id, f.workspace.userId, chatId);
    assert.equal(history.messages.length, 2);
    assert.equal(history.messages[1].turn.status, 'queued');
  } finally {
    await f.close();
  }
});

test('source receipt failure rolls back the answer and the next attempt publishes both exactly once', async () => {
  const f = await conversationFixture();
  try {
    const chatId = randomUUID();
    await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
    const work = await send(f, chatId);
    const executor = createConversationExecutor(f.runtime, async () => ({ text: 'Atomic answer', sources: [] }));
    await f.db.platform.query(
      `ALTER TABLE ${f.table('tf_conversation_results')} ADD CONSTRAINT fail_publication CHECK (false)`,
    );
    assert.equal(await executor.process(work), 'retry');
    assert.deepEqual(await results(f), []);
    assert.equal((await f.store.history(f.workspace.id, f.workspace.userId, chatId)).messages.length, 1);
    await f.db.platform.query(`ALTER TABLE ${f.table('tf_conversation_results')} DROP CONSTRAINT fail_publication`);
    await f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp() WHERE id=$1`, [
      work.turnId,
    ]);
    assert.equal(await executor.process({ ...work, generation: 1 }), 'completed');
    assert.deepEqual(await results(f), [
      {
        turn_id: work.turnId,
        sources: [{ kind: 'private-conversation', conversationId: chatId }],
        publication: 'private',
      },
    ]);
    assert.equal(
      (await f.store.history(f.workspace.id, f.workspace.userId, chatId)).messages[1].parts[0].text,
      'Atomic answer',
    );
  } finally {
    await f.close();
  }
});

test('a question card adds no unknown lineage to later replies in the chat', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    let asked = false;
    const choice = {
      tool: 'present.choice',
      prompt: 'Which day?',
      choices: [
        { id: 'mon', label: 'Monday' },
        { id: 'tue', label: 'Tuesday' },
      ],
    };
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      if (!asked) {
        asked = true;
        await executeTool(choice.tool, false, async () => ({ result: {}, sources: [] }), [], choice);
      }
      return { text: 'Tuesday it is', sources: [] };
    });
    const requests = createConversationRequests(f.runtime);
    assert.equal(await executor.process(await send(f, chatId, 'Book the review')), 'idle');
    const [{ requestId }] = (
      await f.db.platform.query(`SELECT id AS "requestId" FROM ${f.table('tf_conversation_requests')}`)
    ).rows;
    await requests.answer(w.id, w.userId, chatId, requestId, randomUUID(), {
      commandId: randomUUID(),
      expectedRevision: 1,
      answer: { kind: 'text', text: 'Tuesday' },
    });
    const [resumed] = await executor.due(w.id);
    assert.equal(await executor.process(resumed), 'completed');
    assert.equal(await executor.process(await send(f, chatId, 'Make it Wednesday')), 'completed');
    assert.deepEqual((await results(f)).at(-1).sources, [{ kind: 'private-conversation', conversationId: chatId }]);
  } finally {
    await f.close();
  }
});
