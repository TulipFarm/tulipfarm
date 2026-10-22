import assert from 'node:assert/strict';
import { Client } from 'pg';
import { soulStorageConfig, readSoulObject, verifyStarterBundle } from '@tulipfarm/workspaces/soul';

assert.equal(process.argv[2], '--read-only');
const client = new Client({
  connectionString: process.env.DATABASE_MIGRATION_URL,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});
const storage = soulStorageConfig();
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('SET LOCAL row_security = off');
  const rows = (
    await client.query(
      `SELECT id, created_by, created_at, soul_commit, soul_bucket, soul_key FROM app.workspaces WHERE ready_at IS NOT NULL ORDER BY id`,
    )
  ).rows;
  assert.ok(rows.length <= 100, 'Inventory exceeds the bounded verification size');
  await client.query('COMMIT');
  let verified = 0;
  for (const row of rows) {
    assert.equal(row.soul_bucket, storage.bucket);
    assert.equal(row.soul_key, `workspaces/${row.id}/soul/initial.bundle`);
    const body = await readSoulObject(storage, row.soul_key, 1024 * 1024);
    const commit = await verifyStarterBundle(body, {
      workspaceId: row.id,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
    });
    assert.equal(commit, row.soul_commit);
    verified++;
  }
  process.stdout.write(
    `${JSON.stringify({ readyWorkspaces: rows.length, verifiedInitialBundles: verified, objectWrites: 0, databaseWrites: 0 })}\n`,
  );
} catch {
  process.stderr.write('Read-only Soul verification failed. No object or database writes were attempted.\n');
  process.exitCode = 1;
} finally {
  await client.end();
  storage.client.destroy();
}
