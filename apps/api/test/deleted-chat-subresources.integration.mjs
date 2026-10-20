import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import { createConversationExecutor } from '../../../packages/conversations/src/runtime.ts';
import { createProjects } from '../../../packages/conversations/src/projects.ts';
import { reverseReply } from '../../../packages/conversations/test/fixture.mjs';
import { requestFixture } from '../../../packages/conversations/test/request-fixture.mjs';
import { registerConversations } from '../src/conversations.ts';
import { securityServerOptions } from '../src/security.ts';

test(
  'a deleted project chat denies its attachments and information requests to the owner and project members',
  { timeout: 60000 },
  async () => {
    const f = await requestFixture();
    const app = Fastify(securityServerOptions());
    const objects = new Map();
    try {
      const { workspace: w, db, table } = f;
      const attachments = createAttachments(f.runtime, {
        putIfAbsent: async (key, value) => {
          if (!objects.has(key)) objects.set(key, Buffer.from(value));
        },
        read: async key => objects.get(key),
        remove: async key => {
          objects.delete(key);
        },
      });
      const member = { id: randomUUID(), user: `member-${randomUUID()}` };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        member.id,
        member.user,
      ]);
      const users = new Map([
        ['owner', w.userId],
        ['member', member.user],
      ]);
      const auth = {
        api: {
          getSession: async ({ headers }) => {
            const id = users.get(headers.get('cookie') ?? '');
            return id ? { user: { id } } : null;
          },
        },
      };
      registerConversations(app, { auth, service: f.store, requests: f.requests, attachments });
      const projects = createProjects(f.runtime),
        projectId = randomUUID();
      await projects.create(w.id, w.userId, { id: projectId, name: 'Launch' });
      await projects.member(w.id, w.userId, projectId, { membershipId: member.id, role: 'member', removed: false });

      const fence = await f.start(),
        chatId = fence.origin.conversationId;
      const item = await f.requests.create(fence, {
        producerId: randomUUID(),
        prompt: 'When?',
        answerSchema: { kind: 'text' },
      });
      const call = (cookie, method, path, payload, headers = {}) =>
        app.inject({
          method,
          url: `/workspaces/${w.id}/conversations/${chatId}${path}`,
          headers: { cookie, origin: 'http://localhost:5173', ...headers },
          ...(payload === undefined ? {} : { payload }),
        });
      const answer = { commandId: randomUUID(), expectedRevision: 1, answer: { kind: 'text', text: 'Private answer' } };
      assert.equal(
        (await call('owner', 'PUT', `/requests/${item.requestId}/responses/${randomUUID()}`, answer)).statusCode,
        200,
      );
      const executor = createConversationExecutor(f.runtime, reverseReply);
      assert.equal(await executor.process((await executor.due(w.id))[0]), 'completed');

      const uploadId = randomUUID(),
        content = Buffer.from('private attachment');
      const metadata = {
        filename: 'private.txt',
        mediaType: 'text/plain',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
      assert.equal((await call('owner', 'PUT', `/uploads/${uploadId}`, metadata)).statusCode, 200);
      assert.equal(
        (
          await call('owner', 'PUT', `/uploads/${uploadId}/content`, content, {
            'content-type': 'application/octet-stream',
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await call('owner', 'PUT', `/messages/${randomUUID()}`, {
            commandId: randomUUID(),
            parts: [{ kind: 'attachment', attachmentId: uploadId }],
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await call('owner', 'POST', '/move', {
            commandId: randomUUID(),
            projectId,
            confirmFullHistoryIncludingAdmins: true,
          })
        ).statusCode,
        200,
      );

      const reads = [
        ['attachment status', `/uploads/${uploadId}`],
        ['attachment download', `/attachments/${uploadId}/content`],
        ['information request', `/requests/${item.requestId}`],
      ];
      for (const cookie of ['owner', 'member']) {
        for (const [name, path] of reads)
          assert.equal((await call(cookie, 'GET', path)).statusCode, 200, `${cookie} ${name} before deletion`);
        assert.deepEqual((await call(cookie, 'GET', `/attachments/${uploadId}/content`)).rawPayload, content);
      }

      assert.equal((await call('owner', 'DELETE', '', { commandId: randomUUID() })).statusCode, 200);
      for (const cookie of ['owner', 'member']) {
        assert.equal((await call(cookie, 'GET', '')).statusCode, 404, `${cookie} metadata after deletion`);
        for (const [name, path] of reads) {
          const response = await call(cookie, 'GET', path);
          assert.equal(response.statusCode, 404, `${cookie} ${name} after deletion`);
          assert.deepEqual(response.json(), { error: 'conversation-not-found' });
        }
      }
    } finally {
      await app.close();
      await f.close();
    }
  },
);
