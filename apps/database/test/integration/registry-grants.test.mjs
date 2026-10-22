import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { fixture, loadPlatformBaseline } from '../../../../packages/workspace-storage/test/integration/fixture.mjs';
import { grantApplicationAccess } from '../../src/postgres.ts';

test('application grant replay restores registry access after the app schema is rebuilt', async () => {
  const db = await fixture();
  const role = `registry_${randomUUID().replaceAll('-', '')}`;
  try {
    await loadPlatformBaseline(db.platform);
    await provisionTableRegistry(db.platform, {
      capability: 'authoring',
      role,
      password: randomBytes(32).toString('hex'),
    });
    await db.platform.query('DROP SCHEMA app, model_lifecycle CASCADE');
    await loadPlatformBaseline(db.platform);
    const access = async () =>
      (
        await db.databaseAdmin.query(
          `SELECT has_schema_privilege($1, 'app', 'USAGE') AS schema,
      has_column_privilege($1, 'app.workspace_storage', 'runtime_credential', 'SELECT') AS credential,
      has_column_privilege($1, 'app.workspace_storage', 'error_code', 'SELECT') AS extra`,
          [role],
        )
      ).rows[0];
    assert.deepEqual(await access(), { schema: false, credential: false, extra: false });
    await grantApplicationAccess(db.databaseAdmin, 'isolated-v1');
    assert.deepEqual(await access(), { schema: true, credential: true, extra: false });
  } finally {
    try {
      await db.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
      await db.admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
    } finally {
      await db.close();
    }
  }
});
