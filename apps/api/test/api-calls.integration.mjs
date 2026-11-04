import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { proposeApiCall } from '@tulipfarm/api-calls';
import { authenticatedFixture } from './auth-fixture.mjs';
import { createApiCallReviews, registerApiCalls } from '../src/api-calls.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';

test(
  'only the member who made a change can see and decide it, and deciding wakes its chat',
  { timeout: 60000 },
  async () => {
    let authenticated;
    const f = await conversationFixture(undefined, async db => {
        authenticated = await authenticatedFixture(db);
        return { userId: authenticated.owner.id, close: () => authenticated.identity.end() };
      }),
      app = Fastify();
    try {
      const { db, table, workspace: w } = f;
      await authenticated.addAdmin(w);
      const { auth, owner, admin } = authenticated;
      const woken = [];
      registerApiCalls(
        app,
        auth,
        createApiCallReviews({
          runtime: f.runtime,
          resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
          wakeChat: (workspaceId, conversationId) => woken.push({ workspaceId, conversationId }),
          wakeTask: async (workspaceId, taskId) => void woken.push({ workspaceId, taskId }),
        }),
      );
      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      async function http(path, method = 'GET', body, human = owner, origin = 'http://localhost:5173') {
        const response = await fetch(`${url}/workspaces/${w.id}${path}`, {
          method,
          headers: {
            ...(human ? { cookie: human.cookie } : {}),
            origin,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return { status: response.status, body: await response.json() };
      }

      const conversationId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId: conversationId, commandId: randomUUID() });
      const { turnId } = await f.store.send(w.id, w.userId, conversationId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Close the ticket' }],
      });
      await db.platform.query(`UPDATE ${table('tf_conversation_turns')} SET status='waiting' WHERE id=$1`, [turnId]);
      const call = {
        tool: 'api.request',
        method: 'PATCH',
        url: 'https://api.example.test/tickets/7',
        body: { kind: 'json', value: { state: 'closed' } },
      };
      const callId = randomUUID();
      const propose = (id, origin) =>
        proposeApiCall(f.runtime, { workspaceId: w.id, membershipId: w.membershipId, origin, callId: id, call });
      assert.equal((await propose(callId, { kind: 'chat', conversationId, turnId, generation: 0 })).kind, 'waiting');

      const path = `/api-calls/${callId}`;
      const view = await http(path);
      assert.equal(view.status, 200);
      assert.equal(view.body.status, 'awaiting-approval');
      assert.equal(view.body.method, 'PATCH');
      assert.equal(view.body.body.preview, '{"state":"closed"}');
      assert.deepEqual(await http(path, 'GET', undefined, admin), {
        status: 404,
        body: { error: 'api-call-not-found' },
      });
      assert.equal((await http(path, 'GET', undefined, null)).status, 401);
      assert.equal((await http(`/api-calls/${randomUUID()}`)).status, 404);

      const decision = { commandId: randomUUID(), decision: 'approve', digest: view.body.digest };
      assert.deepEqual(await http(`${path}/decision`, 'POST', decision, owner, 'https://evil.example'), {
        status: 403,
        body: { error: 'untrusted-origin' },
      });
      assert.equal((await http(`${path}/decision`, 'POST', decision, admin)).status, 404);
      assert.deepEqual(await http(`${path}/decision`, 'POST', { ...decision, decision: 'maybe' }), {
        status: 400,
        body: { error: 'invalid-api-call-decision' },
      });
      assert.deepEqual(await http(`${path}/decision`, 'POST', { ...decision, digest: 'b'.repeat(64) }), {
        status: 409,
        body: { error: 'api-call-conflict' },
      });
      assert.equal(woken.length, 0);

      const decided = await http(`${path}/decision`, 'POST', decision);
      assert.equal(decided.status, 200);
      assert.equal(decided.body.status, 'sending');
      assert.deepEqual(woken, [{ workspaceId: w.id, conversationId }]);
      assert.equal((await http(`${path}/decision`, 'POST', decision)).status, 200);
      assert.equal(
        (await http(`${path}/decision`, 'POST', { ...decision, commandId: randomUUID(), decision: 'reject' })).status,
        409,
      );

      const taskId = randomUUID();
      const taskCall = randomUUID();
      await propose(taskCall, { kind: 'task', taskId, runId: randomUUID() });
      const listed = await http(`/agent-tasks/${taskId}/api-calls`);
      assert.equal(listed.status, 200);
      assert.deepEqual(
        listed.body.calls.map(item => [item.id, item.origin]),
        [[taskCall, { kind: 'task', taskId }]],
      );
      assert.deepEqual((await http(`/agent-tasks/${taskId}/api-calls`, 'GET', undefined, admin)).body, { calls: [] });
    } finally {
      await app.close();
      await f.close();
    }
  },
);
