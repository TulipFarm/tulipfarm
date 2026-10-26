import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createConversationTitles } from '../../src/titles.ts';
import { conversationEventChannel, conversationNotificationSchema } from '../../src/events.ts';
import { conversationFixture } from '../fixture.mjs';

const { Client } = createRequire(new URL('../../../workspace-storage/package.json', import.meta.url))('pg');
const placeholder = 'Help me track customer follow-ups';

test('a first reply is delivered before its title, which then saves once and never overwrites a manual title', async () => {
  const f = await conversationFixture();
  const listener = new Client({ connectionString: f.db.connectionString });
  try {
    const { workspace: w, store } = f;
    const titles = createConversationTitles(f.runtime);
    const received = [];
    await listener.connect();
    listener.on('notification', message => {
      if (message.channel === conversationEventChannel)
        received.push(conversationNotificationSchema.parse(JSON.parse(message.payload)));
    });
    await listener.query(`LISTEN ${conversationEventChannel}`);
    async function create() {
      const id = randomUUID();
      await store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
      return id;
    }
    async function send(id, text = placeholder) {
      const sent = await store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text }],
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
    const delivered = async (id, turnId) =>
      (await store.history(w.id, w.userId, id)).messages.find(message => message.turn?.id === turnId)?.turn.status;

    const id = await create();
    const work = await send(id);
    const later = await send(id, 'And the overdue ones?');
    const inputs = [];
    const executor = createConversationExecutor(f.runtime, async input => {
      inputs.push(input);
      return { text: 'Your follow-up plan is ready.', sources: [] };
    });
    const stale = await executor.claim(work);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET lease_until = clock_timestamp() - interval '1 second' WHERE id=$1`,
      [work.turnId],
    );
    const retry = await executor.claim(work);
    assert.equal(await executor.complete(stale), 'stale');
    assert.equal(await executor.complete(retry), 'completed');
    assert.deepEqual(await executor.processReply(work), { outcome: 'idle' });

    const first = await createConversationExecutor(f.runtime, async () => ({
      text: 'Done.',
      sources: [],
    })).processReply(await send(await create()));
    assert.deepEqual(first, { outcome: 'completed', title: { titleRevision: 1 } });

    const titled = await create();
    const firstWork = await send(titled);
    assert.deepEqual(await executor.processReply(firstWork), { outcome: 'completed', title: { titleRevision: 1 } });
    assert.ok(inputs.every(input => !('generateTitle' in input)));
    // The reply is complete and visible while the chat still has its placeholder title.
    assert.equal(await delivered(titled, firstWork.turnId), 'completed');
    assert.equal((await store.read(w.id, w.userId, titled)).title, placeholder);
    const titleWork = { ...firstWork, titleRevision: 1 };
    assert.deepEqual(await titles.request(titleWork), { text: placeholder, model: inputs.at(-1).model });
    const before = received.length;
    assert.equal(await titles.save(titleWork, 'Customer follow-ups'), 'generated');
    const saved = await store.read(w.id, w.userId, titled);
    assert.equal(saved.title, 'Customer follow-ups');
    assert.equal(saved.titleRevision, 2);
    assert.equal(saved.titleManual, false);
    assert.equal(
      (await store.list(w.id, w.userId)).chats.find(chat => chat.id === titled).title,
      'Customer follow-ups',
    );
    for (let wait = 0; wait < 100 && !received.slice(before).some(item => item.conversationId === titled); wait++)
      await delay(20);
    assert.deepEqual(
      received.slice(before).filter(item => item.conversationId === titled),
      [{ kind: 'changed', workspaceId: w.id, conversationId: titled }],
    );
    assert.equal(await titles.request(titleWork), null);
    assert.equal(await titles.save(titleWork, 'A second title'), 'skipped');

    const followUp = await send(titled, 'And the overdue ones?');
    assert.deepEqual(await executor.processReply(followUp), { outcome: 'completed' });
    assert.deepEqual(await executor.processReply(later), { outcome: 'completed' });
    assert.equal((await store.read(w.id, w.userId, titled)).title, 'Customer follow-ups');

    for (const timing of ['before-reply', 'during-reply', 'before-request', 'before-save']) {
      const manual = await create();
      const reply = await send(manual);
      if (timing === 'before-reply') await rename(manual);
      const racing = createConversationExecutor(f.runtime, async () => {
        if (timing === 'during-reply') await rename(manual);
        return { text: 'Useful answer', sources: [] };
      });
      const result = await racing.processReply(reply);
      assert.equal(result.outcome, 'completed');
      if (timing === 'before-reply' || timing === 'during-reply') assert.equal(result.title, undefined);
      else {
        const titleWork = { ...reply, ...result.title };
        if (timing === 'before-save') assert.ok(await titles.request(titleWork));
        await rename(manual);
        assert.equal(await titles.request(titleWork), null);
        assert.equal(await titles.save(titleWork, 'Model title'), 'skipped');
      }
      const chat = await store.read(w.id, w.userId, manual);
      assert.equal(chat.title, 'My chosen title', timing);
      assert.equal(chat.titleManual, true);
    }

    const attachmentOnly = await create();
    const silent = await send(attachmentOnly, '   ');
    const result = await executor.processReply(silent);
    assert.equal(result.outcome, 'completed');
    if (result.title) assert.equal(await titles.request({ ...silent, ...result.title }), null);
  } finally {
    await listener.end();
    await f.close();
  }
});

test('a first turn that fails for good still gets its generated title once, and a retried reply keeps it', async () => {
  const f = await conversationFixture();
  try {
    const { workspace: w, store } = f;
    const titles = createConversationTitles(f.runtime);
    const id = randomUUID();
    await store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
    const sent = await store.send(w.id, w.userId, id, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: placeholder }],
    });
    const work = { workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 };
    const failing = createConversationExecutor(f.runtime, async () => {
      throw new Error('model-refusal');
    });
    const failed = await failing.processReply(work);
    assert.deepEqual(failed, { outcome: 'failed', title: { titleRevision: 1, generation: 1 } });
    const titleWork = { ...work, ...failed.title };
    assert.equal((await titles.request(titleWork)).text, placeholder);
    // The reply's own generation no longer names the turn, so stale title work finds nothing.
    assert.equal(await titles.request({ ...work, titleRevision: 1 }), null);
    assert.equal(await titles.save(titleWork, 'Customer follow-ups'), 'generated');
    assert.equal(await titles.request(titleWork), null);

    const retried = await store.retry(w.id, w.userId, id, sent.turnId, {
      commandId: randomUUID(),
      expectedGeneration: failed.title.generation,
    });
    const answered = await createConversationExecutor(f.runtime, async () => ({
      text: 'Your follow-up plan is ready.',
      sources: [],
    })).processReply({ ...work, generation: retried.generation });
    assert.deepEqual(answered, { outcome: 'completed' });
    assert.equal((await store.read(w.id, w.userId, id)).title, 'Customer follow-ups');

    const transient = randomUUID();
    await store.create(w.id, w.userId, { chatId: transient, commandId: randomUUID() });
    const queued = await store.send(w.id, w.userId, transient, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: placeholder }],
    });
    const retrying = createConversationExecutor(f.runtime, async () => {
      throw Object.assign(new Error('lock timeout'), { code: '55P03' });
    });
    assert.deepEqual(
      await retrying.processReply({
        workspaceId: w.id,
        conversationId: transient,
        turnId: queued.turnId,
        generation: 0,
      }),
      { outcome: 'retry' },
    );
  } finally {
    await f.close();
  }
});
