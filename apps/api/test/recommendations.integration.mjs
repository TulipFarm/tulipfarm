import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fallbackRecommendations } from '@tulipfarm/recommendations';
import { registerRecommendations } from '../src/recommendations.ts';

test(
  'recommendation GET reads only the caller saved list and preserves missing-state and access boundaries',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      const w = await db.create(),
        otherId = randomUUID(),
        otherUser = randomUUID();
      const table = name => qualified(w.names.schema, name);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        otherId,
        otherUser,
      ]);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        connectionsPerPool: 3,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const auth = {
        api: {
          getSession: async ({ headers }) => {
            const id = headers.get('x-test-user');
            return id ? { user: { id } } : null;
          },
        },
      };
      app = Fastify();
      registerRecommendations(app, { runtime, auth });
      const read = user =>
        app.inject({
          method: 'GET',
          url: `/workspaces/${w.id}/recommendations`,
          headers: user ? { 'x-test-user': user } : {},
        });
      assert.equal((await read()).statusCode, 401);
      assert.equal((await read(randomUUID())).statusCode, 404);
      const missing = await read(w.userId);
      assert.equal(missing.statusCode, 200);
      assert.equal(missing.headers['cache-control'], 'no-store');
      assert.deepEqual(missing.json().items, fallbackRecommendations);
      for (const [membershipId, label] of [
        [w.membershipId, 'My private finance plan'],
        [otherId, 'My support queue'],
      ]) {
        const items = fallbackRecommendations.map((item, index) => (index ? item : { ...item, label }));
        await db.platform.query(
          `INSERT INTO ${table('tf_recommendation_refresh')}(membership_id,generation,status) VALUES($1,1,'ready')
        ON CONFLICT(membership_id) DO UPDATE SET generation=1,status='ready'`,
          [membershipId],
        );
        await db.platform.query(
          `INSERT INTO ${table('tf_recommendation_snapshots')}(membership_id,fingerprint,items,generation,policy,sources)
        VALUES($1,$2,$3,1,'event-driven-v1','[]')`,
          [membershipId, 'a'.repeat(64), JSON.stringify(items)],
        );
      }
      assert.equal((await read(w.userId)).json().items[0].label, 'My private finance plan');
      const other = await read(otherUser);
      assert.equal(other.json().items[0].label, 'My support queue');
      assert.doesNotMatch(other.body, /finance/);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [otherId]);
      assert.equal((await read(otherUser)).statusCode, 404);
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
