import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createInternalAgentComposition } from '../../../../apps/worker/src/internal-agent-composition.ts';
import { createAttachments } from '../../src/attachments.ts';
import { internalFixture } from '../internal-fixture.mjs';

test('canonical workspaces retain private bytes and fenced internal publication together', async () => {
  const f = await internalFixture();
  try {
    const { workspace: w, table, db } = f;
    const expected = f.stream.map(migration => migration.name).sort();
    const fresh = await db.create(f.stream);
    for (const workspace of [w, fresh]) {
      assert.deepEqual(
        (await db.platform.query(`SELECT name FROM "${workspace.names.schema}".tf_common_migrations `)).rows
          .map(row => row.name)
          .sort(),
        expected,
      );
    }
    const run = await f.run();
    const { callId, ...claim } = run;
    const service = createInternalAgentComposition(f.runtime);
    const fence = await service.claim(claim);
    const objects = new Map();
    const files = createAttachments(f.runtime, {
      putIfAbsent: async (key, value) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(value));
      },
      read: async key => objects.get(key),
      remove: async key => {
        objects.delete(key);
      },
    });
    const chatId = run.origin.conversationId,
      id = randomUUID();
    const bytes = Buffer.from('private combined attachment');
    await files.reserve(w.id, w.userId, chatId, id, {
      filename: 'report.txt',
      mediaType: 'text/plain',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    assert.equal((await files.upload(w.id, w.userId, chatId, id, bytes)).state, 'ready');
    await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'attachment', attachmentId: id }],
    });
    assert.equal(await service.execute(fence, callId), 'completed');
    await service.publishTool(fence, { producerId: randomUUID(), callId });
    assert.deepEqual(
      (await f.store.history(w.id, w.userId, chatId)).messages.map(message => message.parts),
      [
        [{ kind: 'text', text: 'Inspect this privately' }],
        [{ kind: 'attachment', attachmentId: id }],
        [{ kind: 'text', text: 'Tool completed.' }],
      ],
    );
    assert.deepEqual(
      (await service.history(fence)).map(message => message.parts),
      [[{ kind: 'tool', callId }]],
    );
    assert.equal((await files.download(w.id, w.userId, chatId, id)).bytes.toString(), 'private combined attachment');
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'other-admin','admin')`,
      [randomUUID()],
    );
    await assert.rejects(files.download(w.id, 'other-admin', chatId, id), AccessDenied);
    await assert.rejects(f.executor.readResult({ workspaceId: w.id, runId: run.runId, callId }, f.actor), AccessDenied);
  } finally {
    await f.close();
  }
});
