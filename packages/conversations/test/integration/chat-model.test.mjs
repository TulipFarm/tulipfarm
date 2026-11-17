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

test('a reply the fallback wrote because the chat model needs the member to act switches the chat to the fallback', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const send = async model => {
      const messageId = randomUUID();
      const sent = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId,
        parts: [{ kind: 'text', text: 'Check back later.' }],
        ...(model ? { model } : {}),
      });
      return { ...sent, messageId };
    };
    // Only the turn's code matters here, so its own message stands in for the reply.
    const answer = async ({ turnId, messageId }, errorCode) =>
      f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET status='completed', response_message_id=$2, error_code=$3 WHERE id=$1`,
        [turnId, messageId, errorCode],
      );
    const model = async () => (await f.store.read(w.id, w.userId, chatId)).model;

    for (const [code, expected] of [
      ['model-fallback:claude-sonnet:outage', 'claude-opus'],
      ['model-fallback:claude-sonnet:rate-limit', 'claude-opus'],
      ['model-fallback:claude-sonnet:quota:own', 'claude-sonnet'],
      ['model-fallback:claude-sonnet:sign-in', 'claude-sonnet'],
      ['model-fallback:claude-sonnet:model-unavailable:own', 'claude-sonnet'],
    ]) {
      await answer(await send('claude-opus'), code);
      assert.equal(await model(), expected, code);
    }
    // The next turn sent without a model runs on the fallback rather than retrying the chat model.
    const { turnId } = await send();
    const responder = await f.db.platform.query(
      `SELECT responder FROM ${f.table('tf_conversation_turns')} WHERE id=$1`,
      [turnId],
    );
    assert.equal(responder.rows[0].responder, 'claude-sonnet');
    // A reply still being written keeps the model it was sent with.
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET error_code='model-fallback:claude-haiku:quota:own' WHERE id=$1`,
      [turnId],
    );
    assert.equal(await model(), 'claude-sonnet');
  } finally {
    await f.close();
  }
});
