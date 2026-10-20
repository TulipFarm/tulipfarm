import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createPersonalMemoryService } from '@tulipfarm/conversations/personal-memory';
import { registerPersonalMemory } from '../src/personal-memory.ts';
import { authConfig } from '../src/auth.ts';

test(
  'personal memory HTTP only uses the session member, rejects stale edits and enforces origin',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      const w = await db.create();
      const memberId = randomUUID(),
        memberUser = randomUUID();
      await db.platform.query(
        `INSERT INTO ${qualified(w.names.schema, 'tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`,
        [memberId, memberUser],
      );
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const auth = {
        api: {
          getSession: async ({ headers }) => {
            const id = headers.get('x-test-user');
            return id ? { session: { id: 'current-session' }, user: { id } } : null;
          },
        },
      };
      app = Fastify();
      registerPersonalMemory(app, { auth, service: createPersonalMemoryService(runtime) });
      const url = `/workspaces/${w.id}/personal-memory`;
      const request = (method, payload, user = memberUser, origin = authConfig().webOrigin, extra = {}) =>
        app.inject({
          method,
          url,
          headers: { ...(user ? { 'x-test-user': user } : {}), origin, ...extra },
          ...(payload === undefined ? {} : { payload }),
        });
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await request(
          method,
          method === 'GET' ? undefined : { expectedRevision: 0, ...(method === 'PUT' ? { content: '' } : {}) },
          null,
        );
        assert.equal(response.statusCode, 401);
        assert.equal(response.headers['cache-control'], 'no-store');
      }
      assert.equal((await request('GET', undefined, 'outsider')).statusCode, 404);
      assert.equal(
        (await request('PUT', { content: 'secret', expectedRevision: 0 }, memberUser, 'https://attacker.example'))
          .statusCode,
        403,
      );
      assert.equal((await request('DELETE', { expectedRevision: 0 }, memberUser, '')).statusCode, 403);
      assert.equal(
        (
          await request('GET', undefined, memberUser, authConfig().webOrigin, {
            'x-tulipfarm-expected-session': 'old-session',
          })
        ).statusCode,
        401,
      );
      assert.deepEqual((await request('GET')).json(), { content: '', revision: 0 });
      for (const payload of [
        { content: 'secret', expectedRevision: 0, membershipId: w.membershipId },
        { content: 'secret', expectedRevision: 0, userId: w.userId },
        { content: 'x'.repeat(10001), expectedRevision: 0 },
        { content: '🌷'.repeat(10001), expectedRevision: 0 },
        { content: '\0', expectedRevision: 0 },
        { content: 'secret', expectedRevision: -1 },
        { content: 'secret' },
      ])
        assert.equal((await request('PUT', payload)).statusCode, 400);
      let response = await request('PUT', { content: 'My explicit preferences', expectedRevision: 0 });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { content: 'My explicit preferences', revision: 1 });
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual((await request('GET', undefined, w.userId)).json(), { content: '', revision: 0 });
      response = await request('PUT', { content: 'stale', expectedRevision: 0 });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: 'personal_memory_conflict' });
      assert.equal((await request('DELETE', { expectedRevision: 0 })).statusCode, 409);
      assert.equal((await request('DELETE', { expectedRevision: 1, membershipId: memberId })).statusCode, 400);
      response = await request('DELETE', { expectedRevision: 1 });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { content: '', revision: 2 });
      assert.deepEqual((await request('GET')).json(), { content: '', revision: 2 });
      assert.equal((await request('PUT', { content: 'resurrect', expectedRevision: 1 })).statusCode, 409);
      response = await request('PUT', { content: ' \n ', expectedRevision: 2 });
      assert.deepEqual(response.json(), { content: '', revision: 3 });
      await db.platform.query(
        `UPDATE ${qualified(w.names.schema, 'tf_memberships')} SET removed_at=now() WHERE id=$1`,
        [memberId],
      );
      assert.equal((await request('GET')).statusCode, 404);
      assert.equal((await request('DELETE', { expectedRevision: 3 })).statusCode, 404);
      assert.equal((await request('PUT', { content: 'no longer a member', expectedRevision: 3 })).statusCode, 404);
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
