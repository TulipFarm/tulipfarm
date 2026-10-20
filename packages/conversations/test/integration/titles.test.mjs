import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

test('first-turn titles persist separately, survive retry, and never overwrite manual or later titles', async () => {
  const f = await conversationFixture();
  try {
    const { workspace: w, store } = f;
    async function create() {
      const id = randomUUID();
      await store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
      return id;
    }
    async function send(id) {
      const sent = await store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Help me track customer follow-ups' }],
      });
      return { workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 };
    }
    async function rename(id) {
      const chat = await store.read(w.id, w.userId, id);
      await store.rename(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedRevision: chat.titleRevision,
        title: 'My chosen title',
      });
    }
    const id = await create();
    const work = await send(id);
    const later = await send(id);
    const inputs = [];
    const executor = createConversationExecutor(f.runtime, async input => {
      inputs.push(input.generateTitle);
      return {
        text: 'Your follow-up plan is ready.',
        title: inputs.length === 1 ? 'Customer follow-ups' : 'Do not replace the title',
        sources: [],
      };
    });
    const stale = await executor.claim(work);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET lease_until = clock_timestamp() - interval '1 second' WHERE id=$1`,
      [work.turnId],
    );
    const retry = await executor.claim(work);
    assert.equal(await executor.complete(stale), 'stale');
    assert.equal((await store.read(w.id, w.userId, id)).title, 'Help me track customer follow-ups');
    assert.equal(await executor.complete(retry), 'completed');
    assert.equal(await executor.process(work), 'idle');
    assert.equal((await store.read(w.id, w.userId, id)).title, 'Customer follow-ups');
    assert.equal((await store.read(w.id, w.userId, id)).titleRevision, 2);
    assert.equal((await store.list(w.id, w.userId)).chats[0].title, 'Customer follow-ups');
    assert.equal(await executor.process(later), 'completed');
    assert.deepEqual(inputs, [true, false]);
    assert.equal((await store.read(w.id, w.userId, id)).title, 'Customer follow-ups');
    assert.deepEqual(
      (await store.history(w.id, w.userId, id)).messages
        .filter(message => message.author === 'assistant')
        .map(message => message.parts),
      [
        [{ kind: 'text', text: 'Your follow-up plan is ready.' }],
        [{ kind: 'text', text: 'Your follow-up plan is ready.' }],
      ],
    );

    for (const timing of ['before', 'during']) {
      const manual = await create();
      const first = await send(manual);
      if (timing === 'before') await rename(manual);
      const racing = createConversationExecutor(f.runtime, async input => {
        assert.equal(input.generateTitle, timing === 'during');
        if (timing === 'during') await rename(manual);
        return { text: 'Useful answer', title: 'Model title', sources: [] };
      });
      assert.equal(await racing.process(first), 'completed');
      const saved = await store.read(w.id, w.userId, manual);
      assert.equal(saved.title, 'My chosen title');
      assert.equal(saved.titleManual, true);
    }
    const missing = await create();
    assert.equal(
      await createConversationExecutor(f.runtime, async () => 'Answer without title').process(await send(missing)),
      'completed',
    );
    assert.equal((await store.read(w.id, w.userId, missing)).title, 'Help me track customer follow-ups');
  } finally {
    await f.close();
  }
});
