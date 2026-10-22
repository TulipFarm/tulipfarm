import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import {
  provisionWorkspace,
  qualified,
  rolloutCommonMigrations,
  verifyWorkspaceIsolation,
  withMaintenanceTransaction,
} from '../../src/provisioning.ts';
import { connect, denied, fixture } from './fixture.mjs';

test('column ACLs and callable external routines fail isolation verification', async () => {
  const db = await fixture();
  try {
    const workspace = await db.create();
    const runtime = await connect(db.login(workspace));
    try {
      await db.platform.query('GRANT USAGE ON SCHEMA app TO PUBLIC; GRANT SELECT (secret) ON app.accounts TO PUBLIC');
      assert.deepEqual((await runtime.query('SELECT secret FROM app.accounts')).rows, [{ secret: 'platform-only' }]);
      await assert.rejects(verifyWorkspaceIsolation(db.platform, workspace.id), /ambient privileges/);
      await assert.rejects(
        provisionWorkspace({
          connectionString: db.connectionString,
          workspaceId: workspace.id,
          passwords: workspace.passwords,
          initialAdmin: { userId: workspace.userId, membershipId: workspace.membershipId },
        }),
        /ambient privileges/,
      );
      await db.platform.query('REVOKE SELECT (secret) ON app.accounts FROM PUBLIC');
      await db.platform.query(
        "CREATE FUNCTION public.external_routine() RETURNS integer LANGUAGE sql AS 'SELECT 42'; GRANT EXECUTE ON FUNCTION public.external_routine() TO PUBLIC",
      );
      assert.equal((await runtime.query('SELECT public.external_routine() AS value')).rows[0].value, 42);
      await assert.rejects(verifyWorkspaceIsolation(db.platform, workspace.id), /ambient privileges/);
      await db.platform.query('REVOKE EXECUTE ON FUNCTION public.external_routine() FROM PUBLIC');
      await verifyWorkspaceIsolation(db.platform, workspace.id);
      for (const column of ['applied_revision', 'applied_definition', 'maintenance']) {
        await db.platform.query(
          `GRANT UPDATE (${column}) ON ${qualified(workspace.names.schema, 'tf_table_catalog')} TO ${escapeIdentifier(workspace.names.runtime)}`,
        );
        await assert.rejects(verifyWorkspaceIsolation(db.platform, workspace.id), /protected migration state/);
        await db.platform.query(
          `REVOKE UPDATE (${column}) ON ${qualified(workspace.names.schema, 'tf_table_catalog')} FROM ${escapeIdentifier(workspace.names.runtime)}`,
        );
      }
      await verifyWorkspaceIsolation(db.platform, workspace.id);
    } finally {
      await runtime.end();
    }
  } finally {
    await db.close();
  }
});

test('provisioning removes global and schema runtime defaults without erasing forward grants', async () => {
  const db = await fixture();
  try {
    const workspace = await db.create();
    const runtime = await connect(db.login(workspace));
    const owner = escapeIdentifier(db.owner);
    const schema = escapeIdentifier(workspace.names.schema);
    const runtimeRole = escapeIdentifier(workspace.names.runtime);
    const reprovision = migrations =>
      provisionWorkspace({
        connectionString: db.connectionString,
        workspaceId: workspace.id,
        passwords: workspace.passwords,
        initialAdmin: { userId: workspace.userId, membershipId: workspace.membershipId },
        migrations,
      });
    try {
      for (const scope of ['', `IN SCHEMA ${schema}`]) {
        await db.platform.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} ${scope} GRANT SELECT ON TABLES TO ${runtimeRole}`,
        );
        await db.platform.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} ${scope} GRANT USAGE ON SEQUENCES TO ${runtimeRole}`,
        );
        await db.platform.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} ${scope} GRANT EXECUTE ON FUNCTIONS TO ${runtimeRole}`,
        );
        await db.platform.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(workspace.names.customOwner)} ${scope} GRANT SELECT ON TABLES TO ${escapeIdentifier(workspace.names.confirmation)}`,
        );
      }
      await reprovision(db.baseline);
      await db.platform.query(
        `CREATE TABLE ${schema}.tf_new_common (id bigserial); CREATE FUNCTION ${schema}.tf_new_function() RETURNS integer LANGUAGE sql AS 'SELECT 42'`,
      );
      await denied(runtime, `SELECT * FROM ${schema}.tf_new_common`);
      await denied(runtime, `SELECT nextval('${schema}.tf_new_common_id_seq')`);
      await denied(runtime, `SELECT ${schema}.tf_new_function()`);
      const unexpectedRole = escapeIdentifier(workspace.names.migration);
      await db.platform.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${unexpectedRole}`,
      );
      await reprovision(db.baseline);
      const confirmation = await connect(db.login(workspace, 'confirmation'));
      try {
        await withMaintenanceTransaction({
          connectionString: db.login(workspace, 'migration'),
          workspaceId: workspace.id,
          capability: 'migration',
          operation: async ({ client }) => {
            await client.query(`CREATE TABLE ${schema}.future_custom (id bigserial PRIMARY KEY)`);
          },
        });
        await denied(confirmation, `SELECT * FROM ${schema}.future_custom`);
        await runtime.query(`INSERT INTO ${schema}.future_custom DEFAULT VALUES`);
        assert.equal((await runtime.query(`SELECT id::integer FROM ${schema}.future_custom`)).rows[0].id, 1);
      } finally {
        await confirmation.end();
      }
      const sql =
        'GRANT SELECT ON {{schema}}.tf_soul_head TO {{migration}}; GRANT UPDATE (revision) ON {{schema}}.tf_soul_head TO {{migration}}; REVOKE DELETE ON {{schema}}.tf_outbox FROM {{runtime}};';
      const stream = [
        ...db.baseline,
        { name: '0005_forward_grants.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') },
      ];
      await rolloutCommonMigrations({
        connectionString: db.connectionString,
        migrations: stream,
        listWorkspaceIds: async () => [workspace.id],
      });
      await reprovision(stream);
      const fresh = await db.create(stream);
      for (const target of [workspace, fresh]) {
        const migration = await connect(db.login(target, 'migration'));
        const record = await connect(db.login(target));
        try {
          await migration.query(
            `UPDATE ${qualified(target.names.schema, 'tf_soul_head')} SET revision = 'forward' WHERE id = 1`,
          );
          await denied(record, `DELETE FROM ${qualified(target.names.schema, 'tf_outbox')}`);
        } finally {
          await migration.end();
          await record.end();
        }
      }
    } finally {
      await runtime.end();
    }
  } finally {
    await db.close();
  }
});

test('executor reads immutable inputs and confirmation locks catalog without policy edits', async () => {
  const db = await fixture();
  try {
    const workspace = await db.create();
    const table = name => qualified(workspace.names.schema, name);
    const migration = await connect(db.login(workspace, 'migration'));
    try {
      for (const sql of [
        `SELECT * FROM ${table('tf_authoring_commands')}`,
        `SELECT * FROM ${table('tf_soul_revisions')}`,
      ])
        await migration.query(sql);
      await denied(migration, `UPDATE ${table('tf_memberships')} SET role = 'admin'`);
    } finally {
      await migration.end();
    }
    await withMaintenanceTransaction({
      connectionString: db.login(workspace, 'migration'),
      workspaceId: workspace.id,
      capability: 'migration',
      operation: async ({ client }) => {
        await client.query(`SELECT * FROM ${table('tf_authoring_commands')}`);
        await client.query(`SELECT * FROM ${table('tf_soul_revisions')}`);
      },
    });
    await withMaintenanceTransaction({
      connectionString: db.login(workspace, 'confirmation'),
      workspaceId: workspace.id,
      capability: 'confirmation',
      operation: async ({ client }) => {
        await client.query(`SELECT id FROM ${table('tf_authorization_lock')} FOR SHARE`);
        await client.query(`SELECT * FROM ${table('tf_table_catalog')} FOR UPDATE`);
      },
    });
    const confirmation = await connect(db.login(workspace, 'confirmation'));
    try {
      await denied(confirmation, `UPDATE ${table('tf_table_catalog')} SET applied_revision = 'forged'`);
      await denied(confirmation, `UPDATE ${table('tf_grants')} SET permission = 'manage'`);
    } finally {
      await confirmation.end();
    }
  } finally {
    await db.close();
  }
});
