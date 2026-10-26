import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture, connect, denied } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createConversations, ConversationConflict } from '../../src/index.ts';

test(
  'private store persists ordered queued sends, retries exactly, conceals admin access and retains incarnation ownership',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    let login;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const upgraded = await db.create();
      const fresh = await db.create();
      const table = name => qualified(upgraded.names.schema, name);
      const makeRuntime = () =>
        createWorkspaceRuntime({
          replicaCount: 1,
          maxPools: 2,
          connectionsPerPool: 4,
          reservedConnections: 2,
          databaseConnectionBudget: 20,
          resolveCredential: async id => {
            const workspace = db.workspaces.find(item => item.id === id);
            assert.ok(workspace);
            return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
          },
        });
      runtime = makeRuntime();
      let service = createConversations(runtime);
      const user = upgraded.userId;
      const id = randomUUID();
      const create = { chatId: id, commandId: randomUUID() };
      assert.deepEqual(
        await Promise.all([service.create(upgraded.id, user, create), service.create(upgraded.id, user, create)]),
        [{ id }, { id }],
      );
      const send = {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [
          { kind: 'text', text: ' hello ' },
          { kind: 'text', text: '👨‍👩‍👧‍👦\n' },
        ],
      };
      const [first, replay] = await Promise.all([
        service.send(upgraded.id, user, id, send),
        service.send(upgraded.id, user, id, send),
      ]);
      assert.deepEqual(replay, first);
      assert.equal(first.sequence, 1);
      assert.equal((await service.read(upgraded.id, user, id)).title, 'hello 👨‍👩‍👧‍👦');
      await assert.rejects(
        service.send(upgraded.id, user, id, { ...send, parts: [{ kind: 'text', text: 'changed' }] }),
        ConversationConflict,
      );
      await assert.rejects(
        service.create(upgraded.id, user, { ...create, chatId: randomUUID() }),
        ConversationConflict,
      );
      await assert.rejects(
        service.archive(upgraded.id, user, id, { commandId: send.commandId, archived: true }),
        ConversationConflict,
      );
      const sends = Array.from({ length: 52 }, (_, index) => ({
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: `message ${index}` }],
      }));
      const accepted = await Promise.all(sends.map(input => service.send(upgraded.id, user, id, input)));
      assert.deepEqual(
        accepted.map(item => item.sequence).sort((a, b) => a - b),
        Array.from({ length: 52 }, (_, index) => index + 2),
      );
      const newest = await service.history(upgraded.id, user, id);
      assert.deepEqual(
        newest.messages.map(message => message.sequence),
        Array.from({ length: 50 }, (_, index) => index + 4),
      );
      assert.equal(newest.nextBefore, 4);
      const older = await service.history(upgraded.id, user, id, { before: newest.nextBefore });
      assert.deepEqual(
        older.messages.map(message => message.sequence),
        [1, 2, 3],
      );
      assert.deepEqual(older.messages[0].parts, send.parts);
      assert.deepEqual(older.messages[0].turn, { id: first.turnId, status: 'queued', generation: 0, epoch: 0 });
      assert.equal(older.nextBefore, null);
      assert.deepEqual(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_conversation_outbox')}`)).rows,
        [{ count: 53 }],
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS count FROM ${table('tf_conversation_turns')} WHERE responder = 'claude-sonnet' AND status = 'queued'`,
          )
        ).rows[0].count,
        53,
      );
      await assert.rejects(
        service.send(upgraded.id, user, id, { ...send, commandId: randomUUID() }),
        ConversationConflict,
      );
      assert.equal(
        (await db.platform.query(`SELECT next_message_sequence FROM ${table('tf_conversations')} WHERE id = $1`, [id]))
          .rows[0].next_message_sequence,
        54,
      );
      await db.platform.query(
        `UPDATE ${table('tf_conversation_turns')} SET status = 'processing', lease_until = now() + interval '1 minute' WHERE id = $1`,
        [first.turnId],
      );
      await assert.rejects(
        db.platform.query(
          `UPDATE ${table('tf_conversation_turns')} SET status = 'processing', lease_until = now() + interval '1 minute' WHERE id = $1`,
          [accepted[0].turnId],
        ),
        error => error.code === '23505',
      );
      await db.platform.query(
        `UPDATE ${table('tf_conversation_turns')} SET status = 'failed', lease_until = NULL WHERE id = $1`,
        [first.turnId],
      );
      await assert.rejects(
        db.platform.query(`UPDATE ${table('tf_conversation_turns')} SET status = 'waiting' WHERE id = $1`, [
          accepted[0].turnId,
        ]),
        error => error.code === '23505',
      );
      await db.platform.query(`UPDATE ${table('tf_conversation_turns')} SET status = 'queued' WHERE id = $1`, [
        first.turnId,
      ]);

      const adminId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_memberships')} (id, user_id, role) VALUES ($1,'other-admin','admin')`,
        [adminId],
      );
      assert.deepEqual((await service.list(upgraded.id, 'other-admin')).chats, []);
      for (const operation of [
        () => service.read(upgraded.id, 'other-admin', id),
        () => service.history(upgraded.id, 'other-admin', id),
        () => service.send(upgraded.id, 'other-admin', id, send),
        () => service.archive(upgraded.id, 'other-admin', id, { commandId: randomUUID(), archived: true }),
        () =>
          service.rename(upgraded.id, 'other-admin', id, {
            commandId: randomUUID(),
            title: 'stolen',
            expectedRevision: 1,
          }),
        () => service.create(upgraded.id, 'other-admin', { ...create, commandId: randomUUID() }),
        () => service.read(fresh.id, fresh.userId, id),
      ])
        await assert.rejects(operation, AccessDenied);

      const before = await service.read(upgraded.id, user, id);
      const rename = { commandId: randomUUID(), title: 'Exact %_ title', expectedRevision: 1 };
      assert.deepEqual(await service.rename(upgraded.id, user, id, rename), { titleRevision: 2 });
      assert.deepEqual(await service.rename(upgraded.id, user, id, rename), { titleRevision: 2 });
      await assert.rejects(
        service.rename(upgraded.id, user, id, { ...rename, commandId: randomUUID() }),
        ConversationConflict,
      );
      assert.equal((await service.list(upgraded.id, user, { query: '%_' })).chats[0].id, id);
      assert.deepEqual((await service.list(upgraded.id, user, { query: 'missing' })).chats, []);
      await service.archive(upgraded.id, user, id, { commandId: randomUUID(), archived: true });
      assert.deepEqual((await service.list(upgraded.id, user)).chats, []);
      assert.equal((await service.list(upgraded.id, user, { archived: true })).chats[0].id, id);
      assert.equal((await service.read(upgraded.id, user, id)).activityAt, before.activityAt);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS count FROM ${table('tf_conversation_turns')} WHERE status = 'queued'`,
          )
        ).rows[0].count,
        53,
      );
      await service.archive(upgraded.id, user, id, { commandId: randomUUID(), archived: false });
      await runtime.close();
      runtime = makeRuntime();
      service = createConversations(runtime);
      assert.deepEqual((await service.history(upgraded.id, user, id, { before: 2 })).messages[0].parts, send.parts);
      assert.deepEqual(await service.send(upgraded.id, user, id, send), first);
      assert.equal((await service.read(upgraded.id, user, id)).title, rename.title);

      login = await connect(db.login(upgraded));
      await denied(login, `UPDATE ${table('tf_conversation_messages')} SET author_kind = 'assistant'`);
      await denied(login, `DELETE FROM ${table('tf_conversation_parts')}`);
      await denied(login, `UPDATE ${table('tf_conversation_commands')} SET outcome = '{}'`);
      await denied(login, `UPDATE ${table('tf_conversations')} SET owner_user_id = 'other-admin'`);
      await denied(login, `SELECT * FROM ${qualified(fresh.names.schema, 'tf_conversations')}`);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
        upgraded.membershipId,
      ]);
      await assert.rejects(service.send(upgraded.id, user, id, send), AccessDenied);
      await assert.rejects(service.list(upgraded.id, user), AccessDenied);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id, user_id, role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        user,
      ]);
      await assert.rejects(service.history(upgraded.id, user, id), AccessDenied);
      await assert.rejects(service.create(upgraded.id, user, create), AccessDenied);
      assert.deepEqual((await service.list(upgraded.id, user)).chats, []);
      const newId = randomUUID();
      assert.deepEqual(await service.create(upgraded.id, user, { chatId: newId, commandId: create.commandId }), {
        id: newId,
      });
      const chatIds = await Promise.all(
        Array.from({ length: 51 }, async () => {
          const chatId = randomUUID();
          await service.create(upgraded.id, user, { chatId, commandId: randomUUID() });
          return chatId;
        }),
      );
      await db.platform.query(
        `UPDATE ${table('tf_conversations')} SET activity_at = '2026-09-28T00:00:00.123456Z' WHERE id = ANY($1::uuid[])`,
        [[newId, ...chatIds]],
      );
      const page = await service.list(upgraded.id, user);
      assert.equal(page.chats.length, 50);
      assert.equal(page.nextCursor.activityAt, '2026-09-28T00:00:00.123456Z');
      const next = await service.list(upgraded.id, user, { cursor: page.nextCursor });
      assert.equal(next.chats.length, 2);
      assert.equal(next.nextCursor, null);
      assert.deepEqual([...page.chats, ...next.chats].map(chat => chat.id).sort(), [newId, ...chatIds].sort());
    } finally {
      await login?.end();
      await runtime?.close();
      await db.close();
    }
  },
);
