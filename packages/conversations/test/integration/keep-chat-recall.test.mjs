import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createKeepClient, keepConversationScope } from '@tulipfarm/memory-keep';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { configureKeepChatRecall, createKeepChatRecallDelivery, recalledHeading } from '../../src/keep-chat-recall.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { fakeKeep } from '../fake-keep.mjs';
import { conversationFixture } from '../fixture.mjs';

const compatibility = { minimum: 1, maximum: commonCompatibility.maximum };
const bytes = messages => messages.reduce((total, message) => total + Buffer.byteLength(message.text), 0);

function compactor(window = 100_000) {
  return {
    policy: async () => ({
      automatic: true,
      triggerPercent: 70,
      targetPercent: 30,
      outputPrompt: null,
      revision: 0,
      families: ['claude-haiku'],
    }),
    measure: async ({ messages }) => ({ tokens: bytes(messages), window }),
    window: async () => 200_000,
    summarize: async input => ({
      text:
        input.purpose === 'summary'
          ? JSON.stringify({ goal: 'Plan the offsite', state: 'Venue chosen', decisions: [], openWork: [] })
          : '## Handoff',
      familyId: 'claude-haiku',
      fallbackFrom: null,
    }),
  };
}

/** A chat with three exchanges and a /compact, so the first two move out of the live context. */
async function compactedChat(f) {
  const w = f.workspace,
    chatId = randomUUID();
  const seen = [];
  const executor = createConversationExecutor(
    f.runtime,
    async ({ messages }) => {
      seen.push(messages.map(message => message.text).join('\n'));
      return { text: `reply ${seen.length}`, sources: [] };
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    compactor(),
  );
  const say = async parts => {
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts,
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
  };
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  await say([{ kind: 'text', text: 'The offsite budget is 40000 euros, held in Lisbon.' }]);
  await say([{ kind: 'text', text: 'Book the riverside venue.' }]);
  await say([{ kind: 'text', text: 'Draft the agenda.' }]);
  await say([{ kind: 'compact' }]);
  return { chatId, seen, say };
}

const row = (f, chatId) =>
  f.db.platform
    .query(
      `SELECT covered_through, sent_through, held, forget FROM ${f.table('tf_conversation_keep')} WHERE conversation_id = $1`,
      [chatId],
    )
    .then(result => result.rows[0]);

test(
  'compacted messages reach Keep in the background, are recalled into later replies, and are forgotten on delete',
  { timeout: 60_000 },
  async () => {
    const f = await conversationFixture();
    const keep = fakeKeep();
    const restore = configureKeepChatRecall({ client: keep.client });
    try {
      const w = f.workspace;
      const delivery = createKeepChatRecallDelivery(f.runtime, compatibility);
      const { chatId, seen, say } = await compactedChat(f);
      assert.ok(Number((await row(f, chatId)).covered_through) > 0, 'compaction queues the moved messages');
      assert.deepEqual(keep.calls, [], 'nothing is sent on the reply path');

      assert.deepEqual(await delivery.sync(w.id), { sent: 1, forgotten: 0, failed: 0 });
      const source = keep.sources.values().next().value;
      assert.equal(
        source.scope,
        `ws-${BigInt(`0x${w.id.replaceAll('-', '')}`).toString(36)}-c-${BigInt(`0x${chatId.replaceAll('-', '')}`).toString(36)}`,
      );
      const texts = [...source.episodes.values()].map(episode => episode.text);
      assert.ok(texts.includes('The offsite budget is 40000 euros, held in Lisbon.'));
      assert.ok(texts.includes('reply 1'));
      assert.ok(!texts.some(text => text.includes('Draft the agenda')), 'messages still in the live context stay out');
      assert.equal((await row(f, chatId)).held, true);
      assert.deepEqual(await delivery.sync(w.id), { sent: 0, forgotten: 0, failed: 0 }, 'a sent chat is not resent');

      await say([{ kind: 'text', text: 'Remind me of the budget for Lisbon?' }]);
      const context = seen.at(-1);
      assert.match(context, new RegExp(recalledHeading.replaceAll('.', '\\.')));
      assert.match(context, /<excerpt message-id="[0-9a-f-]{36}" role="user">\nThe offsite budget is 40000 euros/u);
      assert.ok(
        context.indexOf('Working summary of earlier conversation') < context.indexOf(recalledHeading),
        'excerpts follow the working summary',
      );

      keep.client.available = false;
      await say([{ kind: 'text', text: 'And the Lisbon budget again?' }]);
      assert.doesNotMatch(seen.at(-1), new RegExp(recalledHeading), 'an unreachable Keep only skips recall');
      keep.client.available = true;

      await f.store.remove(w.id, w.userId, chatId, { commandId: randomUUID() });
      assert.equal((await row(f, chatId)).forget, true);
      assert.deepEqual(
        await delivery.sync(w.id),
        { sent: 0, forgotten: 1, failed: 0 },
        'a deleted chat is forgotten even with the flag off',
      );
      assert.equal(keep.calls.at(-1), 'forget_source');
      assert.equal(keep.sources.size, 0);
      assert.equal(await row(f, chatId), undefined);
    } finally {
      restore();
      await f.close();
    }
  },
);

test('automatic compaction queues the messages it leaves out of the context', { timeout: 60_000 }, async () => {
  const f = await conversationFixture();
  const keep = fakeKeep();
  const restore = configureKeepChatRecall({ client: keep.client });
  try {
    const w = f.workspace,
      chatId = randomUUID();
    const executor = createConversationExecutor(
      f.runtime,
      async () => 'ok',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      compactor(16_000),
    );
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    for (const word of ['alpha', 'bravo', 'charlie', 'delta']) {
      const sent = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: `${word} ${'x'.repeat(3000)}` }],
      });
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    }
    assert.deepEqual(keep.calls, []);
    await createKeepChatRecallDelivery(f.runtime, compatibility).sync(w.id);
    const texts = [...keep.sources.values()].flatMap(source => [...source.episodes.values()].map(e => e.text));
    assert.ok(texts.some(text => text.startsWith('alpha ')));
    assert.ok(!texts.some(text => text.startsWith('charlie ') || text.startsWith('delta ')));
  } finally {
    restore();
    await f.close();
  }
});

test('a failed send is retried later and never fails the reply', { timeout: 60_000 }, async () => {
  const f = await conversationFixture();
  const keep = fakeKeep();
  const restore = configureKeepChatRecall({ client: keep.client });
  try {
    const delivery = createKeepChatRecallDelivery(f.runtime, compatibility);
    const { chatId } = await compactedChat(f);
    keep.client.available = false;
    assert.deepEqual(await delivery.sync(f.workspace.id), { sent: 0, forgotten: 0, failed: 1 });
    keep.client.available = true;
    assert.deepEqual(await delivery.sync(f.workspace.id), { sent: 0, forgotten: 0, failed: 0 }, 'it waits to retry');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_keep')} SET next_attempt_at = clock_timestamp() WHERE conversation_id = $1`,
      [chatId],
    );
    assert.deepEqual(await delivery.sync(f.workspace.id), { sent: 1, forgotten: 0, failed: 0 });
    assert.equal(keep.sources.size, 1);
  } finally {
    restore();
    await f.close();
  }
});

/** A runtime whose first transaction (the claim) waits for the returned `go` before handing back its rows. */
function pausedAfterClaim(runtime) {
  let claimed, go;
  const signals = {
    claimed: new Promise(resolve => (claimed = resolve)),
    go: () => go(),
  };
  const opened = new Promise(resolve => (go = resolve));
  let first = true;
  return {
    signals,
    runtime: {
      transaction: async (...args) => {
        const result = await runtime.transaction(...args);
        if (first) {
          first = false;
          claimed();
          await opened;
        }
        return result;
      },
    },
  };
}

test('two replicas never claim the same due chat', { timeout: 60_000 }, async () => {
  const f = await conversationFixture();
  const keep = fakeKeep();
  const restore = configureKeepChatRecall({ client: keep.client });
  try {
    await compactedChat(f);
    const a = pausedAfterClaim(f.runtime);
    const sending = createKeepChatRecallDelivery(a.runtime, compatibility).sync(f.workspace.id);
    await a.signals.claimed;
    assert.deepEqual(
      await createKeepChatRecallDelivery(f.runtime, compatibility).sync(f.workspace.id),
      { sent: 0, forgotten: 0, failed: 0 },
      'the other replica skips a claimed chat',
    );
    a.signals.go();
    assert.deepEqual(await sending, { sent: 1, forgotten: 0, failed: 0 });
    assert.equal(keep.calls.filter(call => call === 'ingest').length, 1);
  } finally {
    restore();
    await f.close();
  }
});

test(
  'a forget that overlaps a send on another replica never leaves the deleted chat in Keep',
  { timeout: 60_000 },
  async () => {
    const f = await conversationFixture();
    const keep = fakeKeep();
    const restore = configureKeepChatRecall({ client: keep.client });
    try {
      const w = f.workspace;
      const { chatId } = await compactedChat(f);
      // Replica A claims the chat to send it, then the chat is deleted, which makes it due again at once.
      const a = pausedAfterClaim(f.runtime);
      const sending = createKeepChatRecallDelivery(a.runtime, compatibility).sync(w.id);
      await a.signals.claimed;
      await f.store.remove(w.id, w.userId, chatId, { commandId: randomUUID() });
      // Replica B claims it to forget while nothing has been sent yet, then A sends before B finishes.
      const b = pausedAfterClaim(f.runtime);
      const forgetting = createKeepChatRecallDelivery(b.runtime, compatibility).sync(w.id);
      await b.signals.claimed;
      a.signals.go();
      assert.deepEqual(await sending, { sent: 1, forgotten: 0, failed: 0 });
      assert.equal(keep.sources.size, 1);
      b.signals.go();
      assert.deepEqual(await forgetting, { sent: 0, forgotten: 0, failed: 1 }, 'the stale forget keeps the row');
      assert.equal((await row(f, chatId)).held, true);

      assert.deepEqual(await createKeepChatRecallDelivery(f.runtime, compatibility).sync(w.id), {
        sent: 0,
        forgotten: 1,
        failed: 0,
      });
      assert.equal(keep.calls.at(-1), 'forget_source');
      assert.equal(keep.sources.size, 0);
      assert.equal(await row(f, chatId), undefined);
    } finally {
      restore();
      await f.close();
    }
  },
);

test(
  'without a Keep endpoint, compaction, replies and deletion queue nothing for Keep',
  { timeout: 60_000 },
  async () => {
    const f = await conversationFixture();
    const restore = configureKeepChatRecall({ client: undefined });
    try {
      const delivery = createKeepChatRecallDelivery(f.runtime, compatibility);
      const { chatId, seen, say } = await compactedChat(f);
      await say([{ kind: 'text', text: 'What was the Lisbon budget?' }]);
      assert.match(seen.at(-1), /Working summary of earlier conversation/u);
      assert.doesNotMatch(seen.at(-1), new RegExp(recalledHeading));
      assert.equal(await row(f, chatId), undefined, 'nothing is queued');
      await delivery.sync(f.workspace.id);
      await f.store.remove(f.workspace.id, f.workspace.userId, chatId, { commandId: randomUUID() });
      await delivery.sync(f.workspace.id);
      assert.equal(await row(f, chatId), undefined, 'deletion queues nothing either');
    } finally {
      restore();
      await f.close();
    }
  },
);

test(
  'a real Keep receives, recalls and forgets a compacted chat',
  { timeout: 120_000, skip: !process.env.TEST_KEEP_ENDPOINT && 'TEST_KEEP_ENDPOINT is not set' },
  async () => {
    const f = await conversationFixture();
    const client = createKeepClient({
      endpoint: process.env.TEST_KEEP_ENDPOINT,
      token: process.env.TEST_KEEP_TOKEN ?? '',
      timeoutMs: 10_000,
    });
    const restore = configureKeepChatRecall({ client });
    try {
      const w = f.workspace;
      const delivery = createKeepChatRecallDelivery(f.runtime, compatibility);
      const { chatId, seen, say } = await compactedChat(f);
      assert.deepEqual(await delivery.sync(w.id), { sent: 1, forgotten: 0, failed: 0 });
      assert.deepEqual(await delivery.sync(w.id), { sent: 0, forgotten: 0, failed: 0 });
      await say([{ kind: 'text', text: 'Remind me of the offsite budget in Lisbon?' }]);
      assert.match(
        seen.at(-1),
        /<excerpt message-id="[0-9a-f-]{36}" role="user">\n.*The offsite budget is 40000 euros/u,
      );
      await f.store.remove(w.id, w.userId, chatId, { commandId: randomUUID() });
      assert.deepEqual(await delivery.sync(w.id), { sent: 0, forgotten: 1, failed: 0 });
      const scope = keepConversationScope(w.id, chatId);
      const after = await client.searchKnowledge({ scope, query: 'offsite budget Lisbon', sourceIds: [chatId] });
      assert.equal(after.status, 'ok');
      assert.deepEqual(after.value.hits, [], 'Keep no longer holds the chat');
    } finally {
      restore();
      await f.close();
    }
  },
);
