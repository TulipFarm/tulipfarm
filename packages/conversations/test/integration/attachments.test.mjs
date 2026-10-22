import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixture, connect, denied } from '../../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { createConversations } from '../../src/index.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { reverseReply } from '../fixture.mjs';
import { createAttachments, AttachmentError } from '../../src/attachments.ts';

test('immutable attachments bind atomically, deny private reads, recover lost writes and expire only unbound bytes', async () => {
  const db = await fixture();
  let runtime, login;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    const table = name => qualified(w.names.schema, name);
    // Files joined the default workspace stream in #267, and since #511 a sent attachment can lend its object to a published file.
    // These checks cover attachments alone; no published file exists here, so attachment cleanup still owns every object.
    assert.equal(
      (await db.platform.query('SELECT to_regclass($1)::text AS relation', [table('tf_files')])).rows[0].relation,
      `${w.names.schema}.tf_files`,
    );
    assert.equal((await db.platform.query(`SELECT count(*)::int AS n FROM ${table('tf_files')}`)).rows[0].n, 0);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const store = createConversations(runtime),
      executor = createConversationExecutor(runtime, reverseReply);
    const objects = new Map();
    let loseWrite = true;
    let afterRead = async () => {};
    const bytes = {
      putIfAbsent: async (key, body) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(body));
        if (loseWrite) {
          loseWrite = false;
          throw new Error('lost-write-ack');
        }
      },
      read: async key => {
        const value = objects.get(key);
        assert.ok(value);
        await afterRead();
        return value;
      },
      remove: async key => {
        objects.delete(key);
      },
    };
    let files = createAttachments(runtime, bytes, { quotaBytes: 20 });
    const chat = randomUUID(),
      otherChat = randomUUID(),
      id = randomUUID();
    await store.create(w.id, w.userId, { chatId: chat, commandId: randomUUID() });
    await store.create(w.id, w.userId, { chatId: otherChat, commandId: randomUUID() });
    const content = Buffer.from('private');
    const input = {
      filename: 'report.txt',
      mediaType: 'text/plain',
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    assert.equal((await files.reserve(w.id, w.userId, chat, id, input)).state, 'reserved');
    assert.equal((await files.reserve(w.id, w.userId, chat, id, input)).id, id);
    await assert.rejects(files.reserve(w.id, w.userId, chat, id, { ...input, filename: 'changed' }), AttachmentError);
    await assert.rejects(files.upload(w.id, w.userId, chat, id, content), /lost-write-ack/);
    files = createAttachments(runtime, bytes, { quotaBytes: 20 });
    assert.equal((await files.upload(w.id, w.userId, chat, id, content)).state, 'ready');
    await assert.rejects(files.upload(w.id, w.userId, chat, id, Buffer.from('changed')), AttachmentError);
    await assert.rejects(files.download(w.id, w.userId, chat, id), AccessDenied);
    const message = {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [
        { kind: 'text', text: 'before' },
        { kind: 'attachment', attachmentId: id },
        { kind: 'text', text: 'after' },
      ],
    };
    await assert.rejects(store.send(w.id, w.userId, otherChat, message), AttachmentError);
    const [accepted, replay] = await Promise.all([
      store.send(w.id, w.userId, chat, message),
      store.send(w.id, w.userId, chat, message),
    ]);
    assert.deepEqual(accepted, replay);
    assert.deepEqual((await store.history(w.id, w.userId, chat)).messages[0].parts, message.parts);
    assert.deepEqual((await files.download(w.id, w.userId, chat, id)).bytes, content);
    await assert.rejects(
      store.send(w.id, w.userId, chat, { ...message, commandId: randomUUID(), messageId: randomUUID() }),
      AttachmentError,
    );
    await store.archive(w.id, w.userId, chat, { commandId: randomUUID(), archived: true });
    await db.platform.query(
      `UPDATE ${table('tf_conversation_attachments')} SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    assert.equal(await files.cleanup(w.id), 0);
    assert.deepEqual((await files.download(w.id, w.userId, chat, id)).bytes, content);
    const adminId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'other-admin','admin')`,
      [adminId],
    );
    await assert.rejects(files.status(w.id, 'other-admin', chat, id), AccessDenied);
    await assert.rejects(files.download(w.id, 'other-admin', chat, id), AccessDenied);
    const unbound = randomUUID();
    await files.reserve(w.id, w.userId, otherChat, unbound, input);
    await files.upload(w.id, w.userId, otherChat, unbound, content);
    await assert.rejects(
      files.reserve(w.id, w.userId, otherChat, randomUUID(), input),
      error => error.code === 'attachment-quota',
    );
    await db.platform.query(
      `UPDATE ${table('tf_conversation_attachments')} SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [unbound],
    );
    assert.equal(await files.cleanup(w.id), 1);
    assert.equal((await files.status(w.id, w.userId, otherChat, unbound)).state, 'abandoned');
    await assert.rejects(
      files.upload(w.id, w.userId, otherChat, unbound, content),
      error => error.code === 'attachment-expired',
    );
    assert.equal(objects.size, 1);
    const late = randomUUID();
    await files.reserve(w.id, w.userId, otherChat, late, input);
    let sweepDuringWrite = true;
    const racingFiles = createAttachments(runtime, {
      ...bytes,
      putIfAbsent: async (key, body) => {
        if (sweepDuringWrite) {
          sweepDuringWrite = false;
          await db.platform.query(
            `UPDATE ${table('tf_conversation_attachments')} SET expires_at = now() - interval '1 second' WHERE id = $1`,
            [late],
          );
          await files.cleanup(w.id);
        }
        objects.set(key, Buffer.from(body));
      },
    });
    await assert.rejects(
      racingFiles.upload(w.id, w.userId, otherChat, late, content),
      error => error.code === 'attachment-expired',
    );
    await db.platform.query(
      `UPDATE ${table('tf_conversation_attachments')} SET cleanup_after = now() - interval '1 second' WHERE id = $1`,
      [late],
    );
    await files.cleanup(w.id);
    assert.equal(objects.size, 1, 'late writes are deleted by a later abandoned-key sweep');
    const only = randomUUID();
    await files.reserve(w.id, w.userId, otherChat, only, input);
    await files.upload(w.id, w.userId, otherChat, only, content);
    await store.send(w.id, w.userId, otherChat, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'attachment', attachmentId: only }],
    });
    for (const work of await executor.due(w.id)) await executor.process(work);
    assert.equal((await store.read(w.id, w.userId, otherChat)).title, 'Attachments');
    assert.equal((await store.history(w.id, w.userId, otherChat)).messages[1].parts[0].text, 'Attachment received.');
    login = await connect(db.login(w));
    await denied(login, `UPDATE ${table('tf_conversation_attachments')} SET object_key = $1`, [randomUUID()]);
    await denied(login, `DELETE FROM ${table('tf_conversation_attachments')}`);
    const pending = randomUUID();
    await createAttachments(runtime, bytes).reserve(w.id, w.userId, otherChat, pending, input);
    afterRead = async () => {
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
        w.membershipId,
      ]);
    };
    await assert.rejects(
      createAttachments(runtime, bytes).upload(w.id, w.userId, otherChat, pending, content),
      AccessDenied,
    );
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at = NULL WHERE id = $1`, [w.membershipId]);
    afterRead = async () => {
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
        w.membershipId,
      ]);
    };
    await assert.rejects(files.download(w.id, w.userId, chat, id), AccessDenied);
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      randomUUID(),
      w.userId,
    ]);
    await assert.rejects(files.download(w.id, w.userId, chat, id), AccessDenied);
  } finally {
    await login?.end();
    await runtime?.close();
    await db.close();
  }
});
