import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { listWorkspaces, WorkspaceDiscoveryUnavailable } from '../src/store.ts';
import {
  connect,
  denied,
  fixture,
  loadPlatformBaseline,
  markWorkspaceReady,
} from '../../workspace-storage/test/integration/fixture.mjs';

test(
  'discovery scans 102 and 200 real workspace identities with current membership and fails closed',
  { timeout: 240000 },
  async t => {
    const db = await fixture();
    const role = `discovery_${randomUUID().replaceAll('-', '')}`;
    const password = randomBytes(32).toString('hex');
    const users = [randomUUID(), randomUUID()];
    let pool;
    let runtime;
    try {
      await loadPlatformBaseline(db.platform);
      for (const id of users)
        await db.platform.query(
          "INSERT INTO app.users (id, name, email, email_verified) VALUES ($1::uuid, 'Test', $1::text || '@example.test', true)",
          [id],
        );
      await db.platform.query(`
      CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD ${escapeLiteral(password)};
      GRANT CONNECT ON DATABASE ${escapeIdentifier(new URL(db.connectionString).pathname.slice(1))} TO ${escapeIdentifier(role)};
      GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(role)};
      GRANT SELECT ON app.workspaces, app.workspace_storage TO ${escapeIdentifier(role)}`);
      const url = new URL(db.connectionString);
      url.username = role;
      url.password = password;
      pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 1000 });
      const identities = new Set();
      let revoke;
      let badCredential;
      let generation = 0;
      runtime = createWorkspaceRuntime({
        maxPools: 4,
        connectionsPerPool: 1,
        maxConcurrentTransactions: 4,
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 6,
        connectionTimeoutMs: 1000,
        statementTimeoutMs: 1000,
        async resolveCredential(id) {
          assert.equal(
            (
              await pool.query(
                "SELECT workspace_id FROM app.workspace_storage WHERE workspace_id = $1 AND stage = 'ready'",
                [id],
              )
            ).rowCount,
            1,
          );
          const item = db.workspaces.find(item => item.id === id);
          assert.ok(item);
          if (revoke === id) {
            await db.platform.query(
              `UPDATE ${qualified(item.names.schema, 'tf_memberships')} SET removed_at = now() WHERE user_id = $1`,
              [users[0]],
            );
            revoke = undefined;
          }
          const connectionString = new URL(db.login(item));
          if (badCredential === id) connectionString.password = 'invalid-password';
          return { workspaceId: id, generation, connectionString: connectionString.href };
        },
      });
      const store = {
        pool,
        runtime: {
          transaction: (id, versions, operation) =>
            runtime.transaction(id, versions, async transaction => {
              const identity = (await transaction.client.query('SELECT session_user, current_user')).rows[0];
              const item = db.workspaces.find(item => item.id === id);
              assert.deepEqual(identity, { session_user: item.names.runtime, current_user: item.names.runtime });
              identities.add(identity.session_user);
              assert.ok(runtime.stats().pools <= 4);
              assert.ok(runtime.stats().connections <= 4);
              assert.ok(runtime.stats().activeTransactions <= 4);
              return operation(transaction);
            }),
        },
      };
      async function addUntil(count) {
        while (db.workspaces.length < count) {
          const index = db.workspaces.length;
          const item = await db.create();
          await db.platform.query(
            `INSERT INTO ${qualified(item.names.schema, 'tf_memberships')} (id, user_id, role) VALUES ($1, $2, 'member')`,
            [randomUUID(), users[index % 2]],
          );
          await markWorkspaceReady(db.platform, item.id);
          await db.platform.query(
            'UPDATE app.workspaces SET name = $2, slug = $3, created_by = $4, soul_commit = $5, soul_bucket = $6, soul_key = $7, ready_at = now() WHERE id = $1',
            [
              item.id,
              `Workspace ${String(Math.floor(index / 2)).padStart(3, '0')}`,
              `workspace-${index}`,
              users[index % 2],
              'a'.repeat(40),
              'b',
              'k',
            ],
          );
        }
      }
      async function check(user, count) {
        const expected = (
          await db.platform.query('SELECT id FROM app.workspaces WHERE created_by = $1 ORDER BY name, id', [user])
        ).rows.map(row => row.id);
        const result = await listWorkspaces(store, user);
        assert.equal(result.length, count);
        assert.deepEqual(
          result.map(row => row.id),
          expected,
        );
      }
      await addUntil(102);
      for (const user of users) await check(user, 51);
      assert.equal(identities.size, 102);
      await addUntil(200);
      for (const user of users) await check(user, 100);
      assert.equal(identities.size, 200);
      assert.deepEqual(await listWorkspaces(store, randomUUID()), []);
      const revoked = db.workspaces[150];
      revoke = revoked.id;
      const current = await listWorkspaces(store, users[0]);
      assert.equal(current.length, 99);
      assert.ok(!current.some(row => row.id === revoked.id));
      const deniedWorkspace = db.workspaces[151];
      await db.platform.query(
        `REVOKE SELECT ON ${qualified(deniedWorkspace.names.schema, 'tf_memberships')} FROM ${escapeIdentifier(deniedWorkspace.names.runtime)}`,
      );
      await assert.rejects(listWorkspaces(store, users[0]), WorkspaceDiscoveryUnavailable);
      assert.equal(runtime.stats().activeTransactions, 0);
      await db.platform.query(
        `GRANT SELECT ON ${qualified(deniedWorkspace.names.schema, 'tf_memberships')} TO ${escapeIdentifier(deniedWorkspace.names.runtime)}`,
      );
      badCredential = deniedWorkspace.id;
      generation++;
      await assert.rejects(listWorkspaces(store, users[0]), WorkspaceDiscoveryUnavailable);
      assert.equal(runtime.stats().activeTransactions, 0);
      badCredential = undefined;
      generation++;
      assert.equal((await listWorkspaces(store, users[0])).length, 99);
      const registry = await connect(url.href);
      try {
        await denied(registry, `SELECT * FROM ${qualified(revoked.names.schema, 'tf_memberships')}`);
      } finally {
        await registry.end();
      }
      t.diagnostic(
        '200 distinct direct runtime logins; at most four pools, integrations, and permission checks; registry login denied workspace SQL',
      );
    } finally {
      await runtime?.close();
      await pool?.end();
      await db.close();
      const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
      try {
        await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
