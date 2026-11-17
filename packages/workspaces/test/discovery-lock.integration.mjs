import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { listWorkspaces } from '../src/store.ts';
import {
  fixture,
  loadPlatformBaseline,
  markWorkspaceReady,
} from '../../workspace-storage/test/integration/fixture.mjs';

test('discovery lists every workspace while one holds its authorization write lock', { timeout: 120000 }, async () => {
  const db = await fixture();
  const user = randomUUID();
  let runtime;
  let pool;
  let holder;
  try {
    await loadPlatformBaseline(db.platform);
    await db.platform.query(
      "INSERT INTO app.users (id, name, email, email_verified) VALUES ($1::uuid, 'Test', $1::text || '@example.test', true)",
      [user],
    );
    for (let index = 0; index < 2; index++) {
      const item = await db.create();
      await db.platform.query(
        `INSERT INTO ${qualified(item.names.schema, 'tf_memberships')} (id, user_id, role) VALUES ($1, $2, 'member')`,
        [randomUUID(), user],
      );
      await markWorkspaceReady(db.platform, item.id);
      await db.platform.query(
        "UPDATE app.workspaces SET name = $2, slug = $3, created_by = $4, soul_commit = $5, soul_bucket = 'b', soul_key = 'k', ready_at = now() WHERE id = $1",
        [item.id, `Workspace ${index}`, `workspace-${index}`, user, 'a'.repeat(40)],
      );
    }
    runtime = createWorkspaceRuntime({
      maxPools: 4,
      connectionsPerPool: 1,
      maxConcurrentTransactions: 4,
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 6,
      connectionTimeoutMs: 1000,
      async resolveCredential(id) {
        const item = db.workspaces.find(item => item.id === id);
        return { workspaceId: id, generation: 0, connectionString: db.login(item) };
      },
    });
    pool = new pg.Pool({ connectionString: db.connectionString, max: 3 });
    holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(
      `SELECT id FROM ${qualified(db.workspaces[0].names.schema, 'tf_authorization_lock')} WHERE id = 1 FOR UPDATE`,
    );
    const started = performance.now();
    const listed = await listWorkspaces({ pool, runtime }, user);
    assert.ok(performance.now() - started < 1000);
    assert.deepEqual(listed.map(row => row.id).sort(), db.workspaces.map(item => item.id).sort());
  } finally {
    await holder?.query('ROLLBACK');
    holder?.release();
    await runtime?.close();
    await pool?.end();
    await db.close();
  }
});
