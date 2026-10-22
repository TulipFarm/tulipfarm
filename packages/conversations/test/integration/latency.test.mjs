import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../fixture.mjs';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createReplyTextPublisher } from '../../src/event-publisher.ts';
import { readChatLatency } from '../../src/latency.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test(
  'chat timing persists first text, retries and waits without counting human time as latency',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Hello' }],
      });
      const turns = f.table('tf_conversation_turns');
      const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      const executor = createConversationExecutor(f.runtime, async input => {
        const publisher = createReplyTextPublisher(f.runtime, input.fence, 0);
        publisher.update(0, 'Hello');
        await publisher.close();
        return 'Hello';
      });

      const admin = f.db.databaseAdmin;
      await admin.query(
        `UPDATE ${turns} SET timing_started_at=clock_timestamp()-interval '8 seconds',timing_state_since=clock_timestamp()-interval '8 seconds' WHERE id=$1`,
        [sent.turnId],
      );
      const fence = await executor.claim(work);
      assert.ok(fence);
      const before = (
        await admin.query(`SELECT timing_claimed_at,timing_queue_seconds FROM ${turns} WHERE id=$1`, [sent.turnId])
      ).rows[0];
      assert.ok(before.timing_queue_seconds >= 8);
      assert.equal(await executor.claim(work), null);
      await admin.query(`UPDATE ${turns} SET status='waiting',lease_until=NULL WHERE id=$1`, [sent.turnId]);
      await admin.query(
        `UPDATE ${turns} SET timing_started_at=timing_started_at-interval '1 hour',timing_state_since=clock_timestamp()-interval '1 hour' WHERE id=$1`,
        [sent.turnId],
      );
      const waiting = await readChatLatency(f.runtime, w.id);
      assert.equal(waiting.oldest.find(p => p.phase === 'active').seconds, 0);
      assert.equal(waiting.oldest.find(p => p.phase === 'first-text').seconds, 0);
      await admin.query(`UPDATE ${turns} SET status='queued',attempts=0,generation=1 WHERE id=$1`, [sent.turnId]);
      assert.equal(await executor.process({ ...work, generation: 1 }), 'completed');
      const row = (
        await admin.query(
          `SELECT timing_attempts,timing_first_text_at,timing_first_text_seconds,timing_human_wait_seconds,timing_finished_at,timing_claimed_at FROM ${turns} WHERE id=$1`,
          [sent.turnId],
        )
      ).rows[0];
      assert.equal(row.timing_attempts, 2);
      assert.ok(row.timing_human_wait_seconds >= 3600);
      assert.ok(row.timing_first_text_seconds >= 8 && row.timing_first_text_seconds < 30);
      assert.ok(row.timing_first_text_at <= row.timing_finished_at);
      assert.deepEqual(row.timing_claimed_at, before.timing_claimed_at);
      assert.equal(await executor.process({ ...work, generation: 1 }), 'idle');
      const snapshot = await readChatLatency(f.runtime, w.id);
      assert.equal(snapshot.durations.find(p => p.phase === 'active').count, 1);
      assert.ok(snapshot.durations.find(p => p.phase === 'active').total < 30);
      assert.ok(snapshot.durations.find(p => p.phase === 'wall').total >= 3608);
      assert.equal(snapshot.states.find(p => p.state === 'completed').count, 1);
      assert.equal(snapshot.attempts, 2);
      assert.ok(snapshot.slow.find(p => p.phase === 'queue').at > 0);
      assert.equal(snapshot.slow.find(p => p.phase === 'active').at, 0);
      await admin.query(`UPDATE ${turns} SET timing_state_since=clock_timestamp()-interval '1 hour' WHERE id=$1`, [
        sent.turnId,
      ]);
      await f.runtime.transaction(w.id, commonCompatibility, tx =>
        tx.client.query(`UPDATE ${turns} SET status='completed' WHERE id=$1`, [sent.turnId]),
      );
      assert.equal(
        (await readChatLatency(f.runtime, w.id)).durations.find(p => p.phase === 'active').total,
        snapshot.durations.find(p => p.phase === 'active').total,
        'repeated terminal writes cannot change a measured duration',
      );
      const stamp = row.timing_first_text_at;
      const stale = createReplyTextPublisher(f.runtime, fence, 0);
      stale.update(0, 'Old text');
      await stale.close();
      assert.deepEqual(
        (await admin.query(`SELECT timing_first_text_at FROM ${turns} WHERE id=$1`, [sent.turnId])).rows[0]
          .timing_first_text_at,
        stamp,
      );
      await assert.rejects(
        f.runtime.transaction(w.id, commonCompatibility, async tx => {
          await tx.client.query(`UPDATE ${turns} SET status='cancelled',response_message_id=NULL WHERE id=$1`, [
            sent.turnId,
          ]);
          throw new Error('rollback');
        }),
        /rollback/,
      );
      assert.equal((await readChatLatency(f.runtime, w.id)).states.find(p => p.state === 'completed').count, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'one queued or unfinished turn exposes alert ages; failed and human-waiting turns do not keep aging',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        admin = f.db.databaseAdmin,
        turns = f.table('tf_conversation_turns');
      const chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Hello' }],
      });
      const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      await admin.query(
        `UPDATE ${turns} SET timing_started_at=clock_timestamp()-interval '61 seconds',timing_state_since=clock_timestamp()-interval '61 seconds' WHERE id=$1`,
        [sent.turnId],
      );
      let snapshot = await readChatLatency(f.runtime, w.id);
      for (const phase of ['queue', 'first-text', 'active'])
        assert.ok(snapshot.oldest.find(p => p.phase === phase).seconds >= 61);
      assert.equal(
        snapshot.durations.find(p => p.phase === 'dispatch').count,
        0,
        'missing timestamps are not zero-second samples',
      );
      const executor = createConversationExecutor(f.runtime);
      await executor.acknowledge(work);
      await executor.acknowledge(work);
      await executor.claim(work);
      snapshot = await readChatLatency(f.runtime, w.id);
      assert.equal(snapshot.durations.find(p => p.phase === 'dispatch').count, 1);
      assert.equal(snapshot.attempts, 1);
      assert.ok(snapshot.slow.find(p => p.phase === 'queue').at > 0);
      await f.runtime.transaction(w.id, commonCompatibility, tx =>
        tx.client.query(
          `UPDATE ${turns} SET status='failed',lease_until=NULL,error_code='attempts-exhausted' WHERE id=$1`,
          [sent.turnId],
        ),
      );
      snapshot = await readChatLatency(f.runtime, w.id);
      assert.ok(snapshot.oldest.every(p => p.seconds === 0));
      assert.equal(snapshot.states.find(p => p.state === 'failed').count, 1);
      assert.ok(
        snapshot.slow.find(p => p.phase === 'active').at > 0,
        'a completed breach remains alertable after failure',
      );
      await admin.query(
        `UPDATE ${turns} SET timing_started_at=timing_started_at-interval '1 hour',timing_state_since=clock_timestamp()-interval '1 hour' WHERE id=$1`,
        [sent.turnId],
      );
      await f.runtime.transaction(w.id, commonCompatibility, tx =>
        tx.client.query(`UPDATE ${turns} SET status='queued',generation=generation+1,error_code=NULL WHERE id=$1`, [
          sent.turnId,
        ]),
      );
      snapshot = await readChatLatency(f.runtime, w.id);
      assert.ok(
        snapshot.oldest.find(p => p.phase === 'active').seconds < 90,
        'time spent failed is excluded after explicit retry',
      );
      await admin.query(`UPDATE ${turns} SET status='waiting',error_code='mcp-action-waiting' WHERE id=$1`, [
        sent.turnId,
      ]);
      snapshot = await readChatLatency(f.runtime, w.id);
      assert.ok(
        snapshot.oldest.find(p => p.phase === 'active').seconds >= 61,
        'external work still counts as system latency',
      );
      await admin.query(`UPDATE ${turns} SET error_code=NULL WHERE id=$1`, [sent.turnId]);
      snapshot = await readChatLatency(f.runtime, w.id);
      assert.ok(
        snapshot.oldest.every(p => p.seconds === 0),
        'user-input wait is not unfinished active work',
      );
    } finally {
      await f.close();
    }
  },
);
