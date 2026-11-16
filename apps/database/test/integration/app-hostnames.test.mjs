import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { connect } from '../../src/postgres.ts';
import { migrate } from '../../src/migrations.ts';

test('app names stay with one app forever and the API role can never delete them', { timeout: 60000 }, async () => {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL, 'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server');
  const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
  const name = `app_hostnames_${randomUUID().replaceAll('-', '')}`;
  const createdRole = !(await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'tulipfarm'")).rowCount;
  let client;
  try {
    if (createdRole) await admin.query('CREATE ROLE tulipfarm NOLOGIN');
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
    url.pathname = `/${name}`;
    client = await connect(url.href);
    await migrate(client, fileURLToPath(new URL('../../migrations/', import.meta.url)));

    const userId = randomUUID();
    const workspaceId = randomUUID();
    const appId = randomUUID();
    await client.query(
      `INSERT INTO app.users (id, name, email, email_verified) VALUES ($1, 'Ada', 'ada@example.test', true)`,
      [userId],
    );
    await client.query(
      `INSERT INTO app.workspaces (id, request_id, created_by, name, creation_name, slug)
       VALUES ($1, $2, $3, 'Acme', 'Acme', 'acme')`,
      [workspaceId, randomUUID(), userId],
    );

    const claim = (hostname, state, app = appId) =>
      client.query(
        `INSERT INTO app.app_hostnames (name, workspace_id, app_id, state, retired_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'retired' THEN now() END)`,
        [hostname, workspaceId, app, state],
      );
    await claim('menu', 'current');
    await claim('old-menu', 'retired');
    await assert.rejects(claim('menu', 'claiming', randomUUID()), { code: '23505' });
    await assert.rejects(claim('menu-2', 'current'), { code: '23505' });
    await assert.rejects(client.query(`UPDATE app.app_hostnames SET retired_at = NULL WHERE name = 'old-menu'`), {
      code: '23514',
    });
    await assert.rejects(client.query(`UPDATE app.app_hostnames SET status = 'deleted' WHERE name = 'menu'`), {
      code: '23514',
    });
    await client.query(`UPDATE app.app_hostnames SET kind = 'server', status = 'active' WHERE name = 'menu'`);
    await assert.rejects(client.query(`UPDATE app.app_hostnames SET release_id = $1 WHERE name = 'menu'`, [appId]), {
      code: '23514',
    });
    assert.deepEqual((await client.query(`SELECT name, kind FROM app.app_hostnames ORDER BY name`)).rows, [
      { name: 'menu', kind: 'server' },
      { name: 'old-menu', kind: 'static' },
    ]);

    const privileges = (
      await client.query(`SELECT
        has_table_privilege('tulipfarm', 'app.app_hostnames', 'INSERT') AS claim,
        has_column_privilege('tulipfarm', 'app.app_hostnames', 'edge_version', 'UPDATE') AS project,
        has_column_privilege('tulipfarm', 'app.app_hostnames', 'kind', 'UPDATE') AS route,
        has_column_privilege('tulipfarm', 'app.app_hostnames', 'app_id', 'UPDATE') AS reassign,
        has_table_privilege('tulipfarm', 'app.app_hostnames', 'DELETE') AS release,
        has_table_privilege('tulipfarm', 'app.app_preview_hosts', 'DELETE') AS rotate,
        has_column_privilege('tulipfarm', 'app.app_preview_hosts', 'app_id', 'UPDATE') AS move,
        has_column_privilege('tulipfarm', 'app.app_usage_cursors', 'metered_before', 'UPDATE') AS resume,
        has_table_privilege('tulipfarm', 'app.app_server_owners', 'INSERT') AS own,
        has_column_privilege('tulipfarm', 'app.app_server_owners', 'workspace_id', 'UPDATE') AS transfer,
        has_table_privilege('tulipfarm', 'app.app_live_requests', 'INSERT') AS mint,
        has_table_privilege('tulipfarm', 'app.app_live_requests', 'SELECT') AS resolve,
        has_table_privilege('tulipfarm', 'app.app_live_requests', 'DELETE') AS close,
        has_column_privilege('tulipfarm', 'app.app_live_requests', 'expires_at', 'UPDATE') AS renew,
        has_column_privilege('tulipfarm', 'app.app_live_requests', 'release_id', 'UPDATE') AS rebind`)
    ).rows[0];
    assert.deepEqual(privileges, {
      claim: true,
      project: true,
      route: true,
      reassign: false,
      release: false,
      rotate: true,
      move: false,
      resume: true,
      own: true,
      transfer: false,
      mint: true,
      resolve: true,
      close: true,
      renew: true,
      rebind: false,
    });
    assert.deepEqual(
      (await client.query(`SELECT relpersistence FROM pg_class WHERE oid = 'app.app_live_requests'::regclass`)).rows,
      [{ relpersistence: 'u' }],
    );
  } finally {
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
    if (createdRole) await admin.query('DROP ROLE tulipfarm');
    await admin.end();
  }
});
