import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { createFiles } from '../../../files/src/index.ts';
import { createConversations } from '../../src/index.ts';
import { createAttachments } from '../../src/attachments.ts';

async function setup() {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const table = name => qualified(w.names.schema, name);
    const objects = new Map();
    const bytes = {
      putIfAbsent: async (key, body) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(body));
      },
      read: async key => {
        const body = objects.get(key);
        assert.ok(body);
        return Buffer.from(body);
      },
      remove: async key => {
        objects.delete(key);
      },
    };
    const files = createFiles(runtime, bytes, { quotaBytes: 10 });
    const attachments = createAttachments(runtime, bytes, { quotaBytes: 10 });
    const store = createConversations(runtime);
    const chat = randomUUID();
    await store.create(w.id, w.userId, { chatId: chat, commandId: randomUUID() });
    const reserve = (size, id = randomUUID()) =>
      attachments.reserve(w.id, w.userId, chat, id, {
        filename: 'Legacy.txt',
        mediaType: 'text/plain',
        size,
        sha256: createHash('sha256').update(Buffer.alloc(size, 'a')).digest('hex'),
      });
    const upload = (size, id = randomUUID(), service = files) =>
      service.upload(
        w.id,
        w.userId,
        id,
        { name: 'File.txt', parentId: null, mediaType: 'text/plain' },
        Buffer.alloc(size, 'f'),
      );
    const total = async () =>
      Number(
        (
          await db.platform.query(`SELECT
      (SELECT COALESCE(sum(size),0) FROM ${table('tf_files')}) +
      (SELECT COALESCE(sum(size),0) FROM ${table('tf_conversation_attachments')} WHERE state <> 'abandoned') AS total`)
        ).rows[0].total,
      );
    return {
      db,
      w,
      runtime,
      table,
      bytes,
      files,
      attachments,
      store,
      chat,
      reserve,
      upload,
      total,
      close: async () => {
        await runtime.close();
        await db.close();
      },
    };
  } catch (error) {
    await runtime?.close();
    await db.close();
    throw error;
  }
}

for (const state of ['ready', 'pending', 'Trash']) {
  test(`legacy reservations count ${state} Files bytes and replay at the exact shared limit`, async () => {
    const f = await setup();
    try {
      await f.files.createFolder(f.w.id, f.w.userId, randomUUID(), { name: 'Empty folder', parentId: null });
      const fileId = randomUUID();
      if (state === 'pending') {
        const failing = createFiles(
          f.runtime,
          {
            ...f.bytes,
            putIfAbsent: async () => {
              throw new Error('storage unavailable');
            },
          },
          { quotaBytes: 10 },
        );
        await assert.rejects(f.upload(6, randomUUID(), failing), /storage unavailable/);
        assert.equal(await f.total(), 0, 'a failed Files upload charges nothing');
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,name,object_key,media_type,size,sha256,ready)
          VALUES ($1,'file',$2,'Earlier.txt',$3,'text/plain',6,repeat('a',64),false)`,
          [fileId, f.w.membershipId, randomUUID()],
        );
      } else {
        assert.equal((await f.upload(6, fileId)).size, 6);
        if (state === 'Trash') await f.files.trash(f.w.id, f.w.userId, fileId, true);
      }
      const id = randomUUID();
      assert.equal((await f.reserve(4, id)).state, 'reserved');
      await assert.rejects(f.reserve(1), error => error.code === 'attachment-quota');
      assert.equal((await f.reserve(4, id)).id, id);
      await assert.rejects(f.reserve(3, id), error => error.code === 'attachment-conflict');
      assert.equal(await f.total(), 10);
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::integer AS count FROM ${f.table('tf_conversation_attachments')}`))
          .rows[0].count,
        1,
      );
    } finally {
      await f.close();
    }
  });
}

for (const state of ['reserved', 'ready', 'bound', 'abandoned']) {
  test(`Files reservations account for ${state} legacy attachment metadata`, async () => {
    const f = await setup();
    try {
      const { id } = await f.reserve(6);
      if (state === 'ready' || state === 'bound')
        await f.attachments.upload(f.w.id, f.w.userId, f.chat, id, Buffer.alloc(6, 'a'));
      if (state === 'bound')
        await f.store.send(f.w.id, f.w.userId, f.chat, {
          commandId: randomUUID(),
          messageId: randomUUID(),
          parts: [{ kind: 'attachment', attachmentId: id }],
        });
      if (state === 'abandoned') {
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_attachments')} SET expires_at = now() - interval '1 second' WHERE id = $1`,
          [id],
        );
        assert.equal(await f.attachments.cleanup(f.w.id), 1);
      }
      assert.equal((await f.attachments.status(f.w.id, f.w.userId, f.chat, id)).state, state);
      const size = state === 'abandoned' ? 10 : 4;
      assert.equal((await f.upload(size)).size, size);
      await assert.rejects(f.upload(1), error => error.code === 'quota');
      assert.equal(await f.total(), 10);
    } finally {
      await f.close();
    }
  });
}

async function waitForBlockedReservations(f, count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await f.db.databaseAdmin.query(
      `SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname = current_database() AND usename = $1 AND wait_event_type = 'Lock'`,
      [f.w.names.runtime],
    );
    if (result.rows[0].count === count) return;
    await setTimeout(10);
  }
  assert.fail(`Expected ${count} concurrent reservations blocked on PostgreSQL locks`);
}

for (const first of ['Files', 'attachments']) {
  test(`simultaneous Files and legacy reservations cannot oversubscribe when ${first} reserves first`, async () => {
    const f = await setup();
    let results;
    try {
      assert.equal((await f.reserve(4)).state, 'reserved');
      await f.db.platform.query('BEGIN');
      await f.db.platform.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209871))', [f.w.names.schema]);
      const start = first === 'Files' ? () => f.upload(6) : () => f.reserve(6);
      const next = first === 'Files' ? () => f.reserve(6) : () => f.upload(6);
      const attempts = [start()];
      results = Promise.allSettled(attempts);
      await waitForBlockedReservations(f, 1);
      attempts.push(next());
      results = Promise.allSettled(attempts);
      await waitForBlockedReservations(f, 2);
      await f.db.platform.query('COMMIT');
      const [winner, loser] = await results;
      assert.equal(winner.status, 'fulfilled');
      assert.equal(winner.value.size, 6);
      assert.equal(loser.status, 'rejected');
      assert.equal(loser.reason.code, first === 'Files' ? 'attachment-quota' : 'quota');
      assert.equal(await f.total(), 10);
      const counts = (
        await f.db.platform.query(`SELECT
        (SELECT count(*)::integer FROM ${f.table('tf_files')}) AS files,
        (SELECT count(*)::integer FROM ${f.table('tf_conversation_attachments')}) AS attachments`)
      ).rows[0];
      assert.deepEqual(counts, first === 'Files' ? { files: 1, attachments: 1 } : { files: 0, attachments: 2 });
    } finally {
      await f.db.platform.query('ROLLBACK');
      await results;
      await f.close();
    }
  });
}
