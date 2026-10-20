import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createConversationRequests } from '../../src/requests.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { reverseReply } from '../fixture.mjs';
import { createInternalConversations } from '../../src/internal.ts';
import { requestFixture } from '../request-fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const question = () => ({ producerId: randomUUID(), prompt: 'Which day?', answerSchema: { kind: 'text' } });
const answer = () => ({ commandId: randomUUID(), expectedRevision: 1, answer: { kind: 'text', text: 'Tuesday' } });

test(
  'durable targeted answers bypass queued sends, arbitrate competing humans, and fence the old generation',
  { timeout: 60000 },
  async () => {
    const f = await requestFixture();
    let restarted;
    try {
      const w = f.workspace,
        fence = await f.start(),
        chatId = fence.origin.conversationId;
      const input = question();
      const [a, b] = await Promise.all([f.requests.create(fence, input), f.requests.create(fence, input)]);
      assert.deepEqual(a, b);
      await assert.rejects(
        f.requests.create(fence, { ...input, prompt: 'Changed' }),
        error => error.code === 'command-conflict',
      );
      const next = await f.store.send(w.id, w.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: 'This is not an answer' }],
      });
      const executor = createConversationExecutor(f.runtime, reverseReply);
      assert.deepEqual(await executor.due(w.id), []);
      assert.equal((await f.requests.read(w.id, w.userId, chatId, a.requestId)).status, 'pending');
      assert.equal(
        await executor.complete({
          workspaceId: w.id,
          conversationId: chatId,
          turnId: fence.origin.turnId,
          generation: 0,
          epoch: fence.origin.epoch,
        }),
        'stale',
      );
      restarted = f.createRuntime();
      const requests = createConversationRequests(restarted),
        body = answer(),
        responseId = randomUUID();
      const results = await Promise.allSettled([
        requests.answer(w.id, w.userId, chatId, a.requestId, responseId, body),
        requests.answer(w.id, w.userId, chatId, a.requestId, randomUUID(), answer()),
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const winner = results.find(result => result.status === 'fulfilled').value;
      assert.equal(winner.status, 'answered');
      const response = await f.db.platform.query(
        `SELECT command_id,id FROM ${f.table('tf_conversation_responses')} WHERE request_id=$1`,
        [a.requestId],
      );
      const replay = { ...body, commandId: response.rows[0].command_id };
      assert.deepEqual(await requests.answer(w.id, w.userId, chatId, a.requestId, response.rows[0].id, replay), winner);
      await assert.rejects(
        requests.answer(w.id, w.userId, chatId, a.requestId, response.rows[0].id, {
          ...replay,
          answer: { kind: 'text', text: 'Wednesday' },
        }),
        error => error.code === 'command-conflict',
      );
      assert.deepEqual((await requests.read(w.id, w.userId, chatId, a.requestId)).response.answer, {
        kind: 'text',
        text: 'Tuesday',
      });
      assert.deepEqual(
        (await f.store.history(w.id, w.userId, chatId)).messages.map(message => message.parts),
        [
          [{ kind: 'text', text: 'Inspect this privately' }],
          [{ kind: 'request', requestId: a.requestId }],
          [{ kind: 'text', text: 'This is not an answer' }],
          [{ kind: 'response', responseId: winner.responseId }],
        ],
      );
      await assert.rejects(requests.create(fence, question()), AccessDenied);
      const due = await executor.due(w.id);
      assert.deepEqual(due, [
        { workspaceId: w.id, conversationId: chatId, turnId: fence.origin.turnId, generation: 1 },
      ]);
      const resumed = await executor.claim(due[0]);
      const current = await createInternalConversations(f.runtime).claim({
        workspaceId: w.id,
        runId: fence.runId,
        ownerId: fence.ownerId,
        origin: {
          kind: 'linked',
          conversationId: chatId,
          turnId: resumed.turnId,
          generation: resumed.generation,
          epoch: resumed.epoch,
        },
      });
      assert.deepEqual(await requests.readForRuntime(current, a.requestId), {
        requestId: a.requestId,
        revision: 1,
        status: 'answered',
        answer: { kind: 'text', text: 'Tuesday' },
      });
      await assert.rejects(requests.readForRuntime(fence, a.requestId), AccessDenied);
      assert.equal(await executor.complete(resumed), 'completed');
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: next.turnId, generation: 0 }),
        'completed',
      );
      assert.deepEqual(
        (await f.store.history(w.id, w.userId, chatId)).messages.slice(-2).map(message => message.parts[0].text),
        ['yletavirp siht tcepsnI', 'rewsna na ton si sihT'],
      );
    } finally {
      await restarted?.close();
      await f.close();
    }
  },
);

test('choice validation, cancellation, expiry and immutable restricted grants', { timeout: 60000 }, async () => {
  const f = await requestFixture();
  try {
    const w = f.workspace;
    const fence = await f.start(),
      chatId = fence.origin.conversationId;
    const request = await f.requests.create(fence, {
      ...question(),
      answerSchema: {
        kind: 'choices',
        multiple: false,
        choices: [
          { id: 'mon', label: 'Monday' },
          { id: 'tue', label: 'Tuesday' },
        ],
      },
    });
    for (const value of [
      { kind: 'text', text: 'Monday' },
      { kind: 'choices', choiceIds: ['other'] },
      { kind: 'choices', choiceIds: ['mon', 'tue'] },
    ]) {
      await assert.rejects(
        f.requests.answer(w.id, w.userId, chatId, request.requestId, randomUUID(), { ...answer(), answer: value }),
        error => error.code === 'request-conflict',
      );
    }
    await assert.rejects(
      f.requests.answer(w.id, w.userId, chatId, request.requestId, randomUUID(), { ...answer(), expectedRevision: 2 }),
      error => error.code === 'request-conflict',
    );
    const body = { ...answer(), answer: { kind: 'choices', choiceIds: ['tue'] } };
    const accepted = await f.requests.answer(w.id, w.userId, chatId, request.requestId, randomUUID(), body);
    assert.equal(accepted.status, 'answered');
    assert.deepEqual((await f.requests.read(w.id, w.userId, chatId, request.requestId)).response.answer, body.answer);
    for (const sql of [
      `UPDATE ${f.table('tf_conversation_requests')} SET prompt='forged'`,
      `UPDATE ${f.table('tf_conversation_responses')} SET answer='{}'`,
      `DELETE FROM ${f.table('tf_conversation_responses')}`,
      `INSERT INTO ${f.table('tf_confirmations')} (id) VALUES ('${randomUUID()}')`,
    ])
      await assert.rejects(
        f.runtime.transaction(w.id, commonCompatibility, tx => tx.client.query(sql)),
        error => error.code === '42501',
      );
    for (const mode of ['cancel', 'expire', 'late-answer']) {
      const current = await f.start(),
        chat = current.origin.conversationId;
      const item = await f.requests.create(current, question());
      const control = { commandId: randomUUID(), expectedRevision: 1 };
      if (mode !== 'cancel')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [item.requestId],
        );
      if (mode === 'cancel') {
        const cancelled = await f.requests.cancel(w.id, w.userId, chat, item.requestId, control);
        assert.equal(cancelled.status, 'cancelled');
        assert.deepEqual(await f.requests.cancel(w.id, w.userId, chat, item.requestId, control), cancelled);
      } else if (mode === 'expire') assert.deepEqual(await f.requests.expire(w.id), { expired: 1 });
      else
        assert.equal(
          (await f.requests.answer(w.id, w.userId, chat, item.requestId, randomUUID(), answer())).status,
          'expired',
        );
      assert.equal(
        (await f.requests.read(w.id, w.userId, chat, item.requestId)).status,
        mode === 'cancel' ? 'cancelled' : 'expired',
      );
      const work = (await createConversationExecutor(f.runtime, reverseReply).due(w.id)).find(
        work => work.conversationId === chat,
      );
      assert.equal(work.generation, 1);
      await assert.rejects(
        f.requests.answer(w.id, w.userId, chat, item.requestId, randomUUID(), answer()),
        error => error.code === 'request-conflict',
      );
    }
  } finally {
    await f.close();
  }
});

test(
  'current private owner, membership incarnation, runtime lease and expiry races remain authoritative',
  { timeout: 60000 },
  async () => {
    const f = await requestFixture();
    try {
      const w = f.workspace,
        fence = await f.start(),
        chatId = fence.origin.conversationId;
      const item = await f.requests.create(fence, question());
      const admin = randomUUID();
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        admin,
      ]);
      await assert.rejects(f.requests.read(w.id, admin, chatId, item.requestId), AccessDenied);
      await assert.rejects(
        f.requests.answer(w.id, admin, chatId, item.requestId, randomUUID(), answer()),
        AccessDenied,
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [item.requestId],
      );
      await Promise.allSettled([
        f.requests.expire(w.id),
        f.requests.answer(w.id, w.userId, chatId, item.requestId, randomUUID(), answer()),
        f.requests.cancel(w.id, w.userId, chatId, item.requestId, { commandId: randomUUID(), expectedRevision: 1 }),
      ]);
      assert.equal((await f.requests.read(w.id, w.userId, chatId, item.requestId)).status, 'expired');
      assert.deepEqual(
        (
          await f.db.platform.query(`SELECT status,generation FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
            fence.origin.turnId,
          ])
        ).rows,
        [{ status: 'queued', generation: 1 }],
      );
      const stale = await f.start();
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_runtime_claims')} SET lease_until=clock_timestamp()-interval '1 second' WHERE conversation_id=$1`,
        [stale.runId],
      );
      await assert.rejects(f.requests.create(stale, question()), AccessDenied);
      const current = await f.start(),
        chat = current.origin.conversationId;
      const pending = await f.requests.create(current, question());
      const body = answer(),
        response = randomUUID();
      await f.requests.answer(w.id, w.userId, chat, pending.requestId, response, body);
      await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        w.membershipId,
      ]);
      await assert.rejects(f.requests.answer(w.id, w.userId, chat, pending.requestId, response, body), AccessDenied);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        w.userId,
      ]);
      await assert.rejects(f.requests.read(w.id, w.userId, chat, pending.requestId), AccessDenied);
      await assert.rejects(f.requests.answer(w.id, w.userId, chat, pending.requestId, response, body), AccessDenied);
    } finally {
      await f.close();
    }
  },
);
