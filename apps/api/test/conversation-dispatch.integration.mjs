import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { conversationFixture, reverseReply } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { registerConversationDispatch } from '../src/conversation-dispatch.ts';
import { approvalFixture } from '../../../packages/conversations/test/approval-fixture.mjs';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import { createAttachments } from '@tulipfarm/conversations/attachments';

test(
  'restricted API identity discovers persisted conversations and dispatches only control IDs',
  { timeout: 15000 },
  async () => {
    const f = await conversationFixture();
    const role = `conversation_api_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    const url = new URL(f.db.connectionString);
    url.username = role;
    url.password = password;
    const pool = new Pool({ connectionString: url.href });
    const app = Fastify({ logger: false });
    let roleCreated = false;
    try {
      const { workspace: w, store } = f;
      await f.db.platform.query(
        "INSERT INTO app.workspace_storage (workspace_id, stage, runtime_credential, migration_credential, confirmation_credential) VALUES ($1, 'ready', '{}', '{}', '{}') ON CONFLICT (workspace_id) DO UPDATE SET stage='ready', runtime_credential='{}', migration_credential='{}', confirmation_credential='{}'",
        [w.id],
      );
      await f.db.admin.query(
        `CREATE ROLE ${escapeIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`,
      );
      roleCreated = true;
      const database = (await f.db.platform.query('SELECT current_database() AS name')).rows[0].name;
      await f.db.platform.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(role)};
      GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(role)};
      GRANT SELECT (workspace_id, generation, stage, runtime_credential, error_code, updated_at), INSERT (workspace_id) ON app.workspace_storage TO ${escapeIdentifier(role)}`);
      await assert.rejects(
        pool.query('SELECT disabled_at FROM app.workspace_storage'),
        error => error.code === '42501',
      );
      assert.deepEqual(
        (await pool.query("SELECT workspace_id FROM app.workspace_storage WHERE stage = 'ready'")).rows,
        [{ workspace_id: w.id }],
      );
      const id = randomUUID();
      await store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
      const sent = await store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'API discovery' }],
      });
      const calls = [];
      const executor = createConversationExecutor(f.runtime, reverseReply);
      registerConversationDispatch(app, {
        pool,
        runtime: f.runtime,
        temporal: {
          connection: { withDeadline: (_deadline, operation) => operation() },
          client: {
            workflow: {
              start: async (name, options) => {
                calls.push({ name, options });
                await executor.process(options.args[0]);
              },
            },
          },
        },
      });
      await app.ready();
      let history;
      for (let attempt = 0; attempt < 100; attempt++) {
        history = await store.history(w.id, w.userId, id);
        if (history.messages.length === 2) break;
        await delay(20);
      }
      assert.deepEqual(
        history.messages.map(message => message.parts.map(part => part.text).join('')),
        ['API discovery', 'yrevocsid IPA'],
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        name: 'conversationReply',
        options: {
          workflowId: `conversation-reply-v1-${w.id}-${sent.turnId}-0`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [{ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        },
      });
    } finally {
      await app.close();
      await pool.end();
      if (roleCreated) {
        await f.db.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
        await f.db.admin.query(`DROP ROLE ${escapeIdentifier(role)}`);
      }
      await f.close();
    }
  },
);

test(
  'periodic discovery expires human waits and cleans unbound bytes without browser reads',
  { timeout: 30000 },
  async () => {
    const f = await approvalFixture();
    const app = Fastify({ logger: false });
    try {
      const { workspace: w, table, db } = f;
      await db.platform.query(
        "UPDATE app.workspace_storage SET stage = 'ready', runtime_credential = '{}', migration_credential = '{}', confirmation_credential = '{}' WHERE workspace_id = $1",
        [w.id],
      );
      const fence = await f.start();
      const information = await createConversationRequests(f.runtime).create(fence, {
        producerId: randomUUID(),
        prompt: 'Expire without a browser',
        answerSchema: { kind: 'text' },
      });
      const approval = await f.pending();
      const objects = new Map();
      const attachments = createAttachments(f.runtime, {
        putIfAbsent: async (key, bytes) => {
          if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
        },
        read: async key => objects.get(key),
        remove: async key => {
          objects.delete(key);
        },
      });
      const chatId = fence.origin.conversationId;
      const uploadId = randomUUID(),
        bytes = Buffer.from('abandoned private bytes');
      await attachments.reserve(w.id, w.userId, chatId, uploadId, {
        filename: 'pending.txt',
        mediaType: 'text/plain',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      await attachments.upload(w.id, w.userId, chatId, uploadId, bytes);
      let initialSweep = false;
      const calls = [];
      registerConversationDispatch(app, {
        pool: db.platform,
        runtime: f.runtime,
        attachments,
        expireApprovals: async workspaceId => {
          for (const id of await f.requests.due(workspaceId)) await f.resolver.expire(workspaceId, id);
          initialSweep = true;
        },
        temporal: {
          connection: { withDeadline: (_deadline, operation) => operation() },
          client: {
            workflow: {
              start: async (_name, options) => {
                calls.push(options.args[0]);
              },
            },
          },
        },
      });
      await app.ready();
      for (let attempt = 0; !initialSweep && attempt < 100; attempt++) await delay(20);
      assert.equal(initialSweep, true);
      assert.equal(objects.size, 1);
      await db.platform.query(
        `UPDATE ${table('tf_conversation_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [information.requestId],
      );
      await db.platform.query(
        `UPDATE ${table('tf_conversation_approval_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [approval.requestId],
      );
      await db.platform.query(
        `UPDATE ${table('tf_conversation_attachments')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [uploadId],
      );
      for (let attempt = 0; (objects.size !== 0 || calls.length < 2) && attempt < 300; attempt++) await delay(20);
      assert.equal(objects.size, 0);
      assert.deepEqual(
        (
          await db.platform.query(`SELECT status FROM ${table('tf_conversation_requests')} WHERE id=$1`, [
            information.requestId,
          ])
        ).rows,
        [{ status: 'expired' }],
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT resolution,confirmation_id FROM ${table('tf_conversation_approval_resolutions')} WHERE request_id=$1`,
            [approval.requestId],
          )
        ).rows,
        [{ resolution: 'expired', confirmation_id: null }],
      );
      assert.deepEqual(
        (await db.platform.query(`SELECT state FROM ${table('tf_conversation_attachments')} WHERE id=$1`, [uploadId]))
          .rows,
        [{ state: 'abandoned' }],
      );
      assert.deepEqual(
        calls.map(work => work.turnId).sort(),
        [fence.origin.turnId, approval.fence.origin.turnId].sort(),
      );
      assert.deepEqual(
        calls.map(work => work.generation),
        [1, 1],
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT count(*)::int AS count FROM ${table('tf_confirmations')} WHERE migration_id=$1`,
            [approval.migrationId],
          )
        ).rows,
        [{ count: 0 }],
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
);
