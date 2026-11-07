import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../fixture.mjs';
import { createConversations } from '../../src/index.ts';

test(
  'pins belong to one member, lead with the newest pin, replay, and hide archived chats',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const { workspace: w, store } = f;
      const other = { id: randomUUID(), user: randomUUID() };
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        other.id,
        other.user,
      ]);
      const first = randomUUID(),
        second = randomUUID();
      for (const chatId of [first, second]) await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });

      const pinFirst = { commandId: randomUUID(), pinned: true };
      assert.deepEqual(await store.pin(w.id, w.userId, first, pinFirst), { pinned: true });
      assert.deepEqual(await store.pin(w.id, w.userId, first, pinFirst), { pinned: true });
      await store.pin(w.id, w.userId, second, { commandId: randomUUID(), pinned: true });
      assert.deepEqual(
        (await store.pinned(w.id, w.userId)).chats.map(chat => [chat.id, chat.pinned]),
        [
          [second, true],
          [first, true],
        ],
      );
      assert.equal(
        (await store.list(w.id, w.userId)).chats.every(chat => chat.pinned),
        true,
      );
      assert.deepEqual((await store.pinned(w.id, other.user)).chats, []);
      await assert.rejects(
        store.pin(w.id, other.user, first, { commandId: randomUUID(), pinned: true }),
        /Resource not found/,
      );

      await store.archive(w.id, w.userId, second, { commandId: randomUUID(), archived: true });
      await store.pin(w.id, w.userId, first, { commandId: randomUUID(), pinned: false });
      assert.deepEqual((await store.pinned(w.id, w.userId)).chats, []);
      assert.equal((await store.read(w.id, w.userId, first)).pinned, false);
    } finally {
      await f.close();
    }
  },
);

test('a workspace that has not applied the pins migration lists chats unpinned and refuses new pins', async () => {
  const f = await conversationFixture();
  try {
    const { workspace: w } = f;
    const older = new Proxy(f.runtime, {
      get: (runtime, key) =>
        key === 'transaction'
          ? (id, compatibility, operation, ...rest) =>
              runtime.transaction(
                id,
                compatibility,
                tx => operation(new Proxy(tx, { get: (t, k) => (k === 'commonVersion' ? 42 : Reflect.get(t, k)) })),
                ...rest,
              )
          : Reflect.get(runtime, key),
    });
    const store = createConversations(older);
    const chatId = randomUUID();
    await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    await f.store.pin(w.id, w.userId, chatId, { commandId: randomUUID(), pinned: true });

    assert.equal((await store.read(w.id, w.userId, chatId)).pinned, false);
    assert.deepEqual(
      (await store.list(w.id, w.userId)).chats.map(chat => chat.pinned),
      [false],
    );
    assert.deepEqual((await store.pinned(w.id, w.userId)).chats, []);
    await assert.rejects(store.pin(w.id, w.userId, chatId, { commandId: randomUUID(), pinned: false }), {
      name: 'StorageUnavailableError',
    });
  } finally {
    await f.close();
  }
});
