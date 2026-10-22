import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createConversations } from '@tulipfarm/conversations';
import { authenticatedFixture } from './auth-fixture.mjs';
import { registerConversations } from '../src/conversations.ts';
import { approvalFixture } from '../../../packages/conversations/test/approval-fixture.mjs';

test(
  'real HTTP approval rechecks human authority and returns recorded decision separately from execution',
  { timeout: 60000 },
  async () => {
    let authenticated;
    const f = await approvalFixture(undefined, async db => {
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
            approvals: { read: f.requests.read, decide: f.resolver.decide },
          }),
        { prefix: '/v1' },
      );
      const address = await app.listen({ host: '127.0.0.1', port: 0 }),
        item = await f.pending();
      const base = `${address}/v1/workspaces/${w.id}/conversations/${item.conversationId}/approvals/${item.requestId}`;
      async function http(method = 'GET', body, human = owner, origin = 'http://localhost:5173') {
        const response = await fetch(`${base}${method === 'PUT' ? '/decision' : ''}`, {
          method,
          headers: { cookie: human.cookie, origin, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return { status: response.status, body: await response.json() };
      }
      const initial = await http();
      assert.equal(initial.status, 200);
      assert.equal(initial.body.resolution, null);
      assert.equal(initial.body.action.migrationId, item.migrationId);
      assert.equal((await http('GET', undefined, admin)).status, 404);
      const body = { commandId: randomUUID(), expectedRevision: 1, decision: 'approve' };
      assert.equal((await http('PUT', body, owner, 'https://other.example')).status, 403);
      assert.equal((await http('PUT', { ...body, confirmationId: randomUUID() })).status, 400);
      assert.equal((await http('PUT', body, admin)).status, 404);
      await f.humanAuthority(item.tableId, false);
      assert.equal((await http('PUT', body)).status, 404);
      await f.humanAuthority(item.tableId, true);
      const accepted = await http('PUT', body);
      assert.equal(accepted.status, 200, JSON.stringify(accepted));
      assert.equal(accepted.body.status, 'approved');
      assert.deepEqual(await http('PUT', body), accepted);
      assert.equal((await http('PUT', { ...body, decision: 'reject' })).status, 409);
      assert.deepEqual(
        (await db.platform.query(`SELECT status FROM ${table('tf_migration_jobs')} WHERE id=$1`, [item.migrationId]))
          .rows,
        [{ status: 'waiting_for_confirmation' }],
      );
      assert.equal((await f.maintenance.execute(w.id, item.migrationId)).status, 'applied');
      assert.deepEqual(await http('PUT', body), accepted);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        w.membershipId,
      ]);
      assert.equal((await http('PUT', body)).status, 404);
    } finally {
      await app.close();
      await f.close();
    }
  },
);
