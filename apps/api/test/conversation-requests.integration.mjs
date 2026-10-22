import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { authenticatedFixture } from './auth-fixture.mjs';
import { registerConversations } from '../src/conversations.ts';
import { requestFixture } from '../../../packages/conversations/test/request-fixture.mjs';
import { createConversationExecutor } from '../../../packages/conversations/src/runtime.ts';
import { reverseReply } from '../../../packages/conversations/test/fixture.mjs';
import { createConversations } from '@tulipfarm/conversations';
import { createConversationRequests } from '@tulipfarm/conversations/requests';

test(
  'real HTTP sessions answer only targeted requests and retain receipts across lost acknowledgements',
  { timeout: 60000 },
  async () => {
    let authenticated;
    const f = await requestFixture(undefined, async db => {
        authenticated = await authenticatedFixture(db);
        return { userId: authenticated.owner.id, close: () => authenticated.identity.end() };
      }),
      app = Fastify();
    try {
      const { db, table, workspace: w } = f;
      await authenticated.addAdmin(w);
      const { auth, owner, admin } = authenticated;
      await app.register(
        async routes =>
          registerConversations(routes, {
            auth,
            service: createConversations(f.runtime),
            requests: createConversationRequests(f.runtime),
          }),
        { prefix: '/v1' },
      );
      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      const fence = await f.start(),
        chatId = fence.origin.conversationId;
      const item = await f.requests.create(fence, {
        producerId: randomUUID(),
        prompt: 'When?',
        answerSchema: { kind: 'text' },
      });
      const base = `${url}/v1/workspaces/${w.id}/conversations/${chatId}`;
      async function http(path, method = 'GET', body, human = owner, origin = 'http://localhost:5173') {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { cookie: human.cookie, origin, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return { status: response.status, body: await response.json() };
      }
      const path = `/requests/${item.requestId}`,
        responsePath = `${path}/responses/${randomUUID()}`;
      assert.equal((await http(path)).body.status, 'pending');
      assert.equal((await http(path, 'GET', undefined, admin)).status, 404);
      const body = { commandId: randomUUID(), expectedRevision: 1, answer: { kind: 'text', text: 'Tuesday' } };
      assert.equal((await http(responsePath, 'PUT', body, owner, 'https://other.example')).status, 403);
      assert.equal((await http(responsePath, 'PUT', { ...body, actor: 'admin' })).status, 400);
      assert.equal((await http(responsePath, 'PUT', body, admin)).status, 404);
      assert.equal(
        (
          await http(`/messages/${randomUUID()}`, 'PUT', {
            commandId: randomUUID(),
            parts: [{ kind: 'text', text: 'Not an answer' }],
          })
        ).status,
        200,
      );
      assert.equal((await http(path)).body.status, 'pending');
      const accepted = await http(responsePath, 'PUT', body);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.status, 'answered');
      assert.deepEqual(await http(responsePath, 'PUT', body), accepted);
      assert.equal(
        (await http(responsePath, 'PUT', { ...body, answer: { kind: 'text', text: 'Changed' } })).status,
        409,
      );
      assert.deepEqual((await http(path)).body.response.answer, { kind: 'text', text: 'Tuesday' });
      assert.deepEqual((await http('/messages')).body.messages.at(-1).parts, [
        { kind: 'response', responseId: accepted.body.responseId },
      ]);
      const executor = createConversationExecutor(f.runtime, reverseReply);
      assert.equal(await executor.process((await executor.due(w.id))[0]), 'completed');
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        w.membershipId,
      ]);
      assert.equal((await http(responsePath, 'PUT', body)).status, 404);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        owner.id,
      ]);
      assert.equal((await http(path)).status, 404);
      assert.equal((await http(responsePath, 'PUT', body)).status, 404);
    } finally {
      await app.close();
      await f.close();
    }
  },
);
