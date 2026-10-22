import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import { createFiles } from '../../../packages/files/src/index.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { registerConversations } from '../src/conversations.ts';
import { securityServerOptions } from '../src/security.ts';

test(
  'a replayed send publishes nothing after the person deleted the published file forever',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    const app = Fastify(securityServerOptions());
    try {
      const { workspace: w, store } = f;
      const objects = new Map();
      const bytes = {
        putIfAbsent: async (key, value) => {
          if (!objects.has(key)) objects.set(key, Buffer.from(value));
        },
        read: async key => Buffer.from(objects.get(key)),
        remove: async key => {
          objects.delete(key);
        },
      };
      const files = createFiles(f.runtime, bytes);
      const eventCount = async () =>
        (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_recommendation_events')}`)).rows[0]
          .count;
      const initialEvents = await eventCount();
      const attachments = createAttachments(f.runtime, bytes, { files });
      registerConversations(app, {
        auth: { api: { getSession: async () => ({ user: { id: w.userId } }) } },
        service: store,
        attachments,
      });
      const chatId = randomUUID(),
        attachmentId = randomUUID();
      await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const content = Buffer.from('a,b\n1,2\n');
      await attachments.reserve(w.id, w.userId, chatId, attachmentId, {
        filename: 'Ledger.csv',
        mediaType: 'text/csv',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
      await attachments.upload(w.id, w.userId, chatId, attachmentId, content);
      const messageId = randomUUID(),
        commandId = randomUUID();
      const send = () =>
        app.inject({
          method: 'PUT',
          url: `/workspaces/${w.id}/conversations/${chatId}/messages/${messageId}`,
          headers: { origin: 'http://localhost:5173' },
          payload: { commandId, parts: [{ kind: 'attachment', attachmentId }] },
        });
      const fileRows = async () =>
        (await f.db.platform.query(`SELECT id, name, trashed_at IS NOT NULL AS trashed FROM ${f.table('tf_files')}`))
          .rows;

      const first = await send();
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual(await fileRows(), [{ id: attachmentId, name: 'Ledger.csv', trashed: false }]);
      assert.equal(
        await eventCount(),
        initialEvents,
        'chat creation, attachment upload and sent-only publication do not enqueue recommendations',
      );

      await files.trash(w.id, w.userId, attachmentId, true);
      assert.equal((await files.deleteForever(w.id, w.userId, attachmentId)).state, 'deleted');
      assert.deepEqual(await fileRows(), []);
      const afterDelete = await eventCount();

      const replay = await send();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), first.json(), 'the replay returns the recorded send');
      assert.deepEqual(await fileRows(), [], 'the deleted file stays deleted');
      assert.equal(await eventCount(), afterDelete, 'a replayed chat send cannot enqueue recommendation work');
      assert.equal(
        (await files.usage(w.id, w.userId)).usedBytes,
        content.length,
        'only the chat attachment is charged',
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
);
