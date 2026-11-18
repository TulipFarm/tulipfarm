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

    // The plan account the member picked is kept on the turn, for the reply to try first.
    const planConnectionId = randomUUID();
    const picked = await f.store.send(w.id, w.userId, fresh, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Answer on my other plan.' }],
      model: 'claude-opus',
      planConnectionId,
    });
    const pickedPlan = async () =>
      (
        await f.db.platform.query(`SELECT plan_connection_id FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
          picked.turnId,
        ])
      ).rows[0].plan_connection_id;
    assert.equal(await pickedPlan(), planConnectionId);

    // Retrying the failed reply queues the same turn again, so it still starts on the picked plan.
    const failed = await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET status='failed', error_code='transient-failure' WHERE id=$1 RETURNING generation`,
      [picked.turnId],
    );
    await f.store.retry(w.id, w.userId, fresh, picked.turnId, {
      commandId: randomUUID(),
      expectedGeneration: failed.rows[0].generation,
    });
    assert.equal(await pickedPlan(), planConnectionId);
  } finally {
    await f.close();
  }
});

test('a reply that moved to another plan account shows the switch, with account names for its requester only', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const [limited, answered] = [randomUUID(), randomUUID()];
    for (const [id, email] of [
      [limited, 'work@example.com'],
      [answered, 'home@example.com'],
    ])
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_subscription_connections')}
           (id, provider, owner_membership_id, state, client_id, subject, email, credential, expires_at, models)
         VALUES ($1, 'claude', $2, 'connected', 'client', $3, $3, '{}', now() + interval '1 hour', '[]')`,
        [id, w.membershipId, email],
      );
    const { turnId } = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Answer on my work plan.' }],
      model: 'claude-opus',
      planConnectionId: limited,
    });
    const turn = async () =>
      (await f.store.history(w.id, w.userId, chatId)).messages.find(message => message.turn?.id === turnId).turn;
    assert.equal((await turn()).planSwitch, undefined);

    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET plan_connection_used=$2,plan_switched_from=$3,plan_switch_reason='usage-limit' WHERE id=$1`,
      [turnId, answered, limited],
    );
    assert.deepEqual((await turn()).planSwitch, {
      fromConnectionId: limited,
      fromAccount: 'work@example.com',
      toConnectionId: answered,
      toAccount: 'home@example.com',
      reason: 'usage-limit',
    });

    // Someone other than the requester sees that the reply switched, but not whose accounts.
    const other = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      other,
      `other-${other}`,
    ]);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_messages')} SET membership_id=$2 WHERE id=(SELECT source_message_id FROM ${f.table('tf_conversation_turns')} WHERE id=$1)`,
      [turnId, other],
    );
    assert.deepEqual((await turn()).planSwitch, {
      fromConnectionId: limited,
      toConnectionId: answered,
      reason: 'usage-limit',
    });
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
