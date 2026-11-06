import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../fixture.mjs';

process.env.ANTHROPIC_API_KEY ??= 'test-placeholder';

test('a chat keeps the model of its latest reply for turns sent without one', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const send = (chatId, model) =>
      f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Check back later.' }],
        ...(model ? { model } : {}),
      });
    const responder = async turnId =>
      (await f.db.platform.query(`SELECT responder FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [turnId]))
        .rows[0].responder;
    const opus = randomUUID();
    const fresh = randomUUID();
    for (const chatId of [opus, fresh]) await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    assert.equal((await f.store.read(w.id, w.userId, fresh)).model, null);

    await send(opus, 'claude-opus');
    assert.equal((await f.store.read(w.id, w.userId, opus)).model, 'claude-opus');
    assert.equal(await responder((await send(opus)).turnId), 'claude-opus');
    assert.equal(await responder((await send(fresh)).turnId), 'claude-sonnet');

    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET responder='retired-model' WHERE conversation_id=$1`,
      [opus],
    );
    assert.equal(await responder((await send(opus)).turnId), 'claude-sonnet');
  } finally {
    await f.close();
  }
});
