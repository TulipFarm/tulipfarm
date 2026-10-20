import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createKnowledgeEmbeddingCapacity } from '../dist/embedding-capacity.js';

test('search capacity deadline cancels lock waits and releases successful connections', async () => {
  const db = await fixture();
  const pool = new Pool({ connectionString: db.connectionString, max: 1 });
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const acquire = () =>
      createKnowledgeEmbeddingCapacity(pool).acquire({
        workspaceId: randomUUID(),
        purpose: 'query',
        tokens: 1,
        attemptId: randomUUID(),
        deadlineAt: Date.now() + 250,
      });
    assert.equal(await acquire(), true);
    const first = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.equal(await acquire(), true);
    assert.equal((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, first);
    await db.platform.query('BEGIN; LOCK TABLE app.knowledge_embedding_capacity_gate IN ACCESS EXCLUSIVE MODE');
    const start = performance.now();
    assert.equal(await acquire(), false);
    assert.ok(performance.now() - start < 1000);
    await db.platform.query('ROLLBACK');
    assert.equal(await acquire(), true);
    assert.equal(pool.waitingCount, 0);
  } finally {
    await db.platform.query('ROLLBACK');
    await pool.end();
    await db.close();
  }
});
