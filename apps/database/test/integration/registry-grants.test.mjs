import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
    for (const migration of [
      '0011_app_hostnames.sql',
      '0012_app_preview_sessions.sql',
      '0013_app_server_routes.sql',
      '0014_app_usage_cursors.sql',
      '0015_app_server_owners.sql',
    ])
      await db.platform.query(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
    const access = async () =>
      (
        await db.databaseAdmin.query(
          `SELECT has_schema_privilege($1, 'app', 'USAGE') AS schema,
      has_column_privilege($1, 'app.workspace_storage', 'runtime_credential', 'SELECT') AS credential,
      has_column_privilege($1, 'app.workspace_storage', 'error_code', 'SELECT') AS extra,
      has_column_privilege($1, 'app.app_hostnames', 'kind', 'UPDATE') AS route,
      has_table_privilege($1, 'app.app_hostnames', 'INSERT') AS claim,
      has_column_privilege($1, 'app.app_usage_cursors', 'metered_before', 'INSERT,UPDATE') AS cursor,
      has_column_privilege($1, 'app.app_server_owners', 'workspace_id', 'INSERT') AS owner,
      has_column_privilege($1, 'app.app_preview_hosts', 'preview_key', 'SELECT') AS preview_key,
      has_table_privilege($1, 'app.app_preview_sessions', 'SELECT') AS preview_session`,
          [role],
        )
      ).rows[0];
    const none = {
      route: false,
      claim: false,
      cursor: false,
      owner: false,
      preview_key: false,
      preview_session: false,
    };
    assert.deepEqual(await access(), { schema: false, credential: false, extra: false, ...none });
    await grantApplicationAccess(db.databaseAdmin, 'isolated-v1');
    assert.deepEqual(await access(), {
      schema: true,
      credential: true,
      extra: false,
      ...none,
      route: true,
      cursor: true,
      owner: true,
    });
  } finally {
    try {
      await db.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
      await db.admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
    } finally {
      await db.close();
    }
  }
});
