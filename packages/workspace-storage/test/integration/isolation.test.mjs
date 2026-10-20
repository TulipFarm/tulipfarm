import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import {
  provisionWorkspace,
  qualified,
  verifyWorkspaceIsolation,
  withMaintenanceTransaction,
} from '../../src/provisioning.ts';
import { connect, denied, fixture } from './fixture.mjs';

test(
  'real workspace logins isolate present and future objects and protect confirmation/application receipts',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const clients = [];
    try {
      const a = await db.create();
      const b = await db.create();
      const at = name => qualified(a.names.schema, name);
      const bt = name => qualified(b.names.schema, name);
      const runtime = await connect(db.login(a));
      const migration = await connect(db.login(a, 'migration'));
      const confirmation = await connect(db.login(a, 'confirmation'));
      clients.push(runtime, migration, confirmation);
      assert.equal((await runtime.query('SELECT current_user')).rows[0].current_user, a.names.runtime);
      assert.equal(
        (await db.platform.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper,
        false,
      );
      for (const workspace of [a, b]) {
        await withMaintenanceTransaction({
          connectionString: db.login(workspace, 'migration'),
          workspaceId: workspace.id,
          capability: 'migration',
          operation: async ({ client, schema }) => {
            await client.query(
              `CREATE TABLE ${qualified(schema, 'invoices')} (id bigserial PRIMARY KEY, value text NOT NULL)`,
            );
          },
        });
      }
      await runtime.query(`INSERT INTO ${at('invoices')} (value) VALUES ('a-only')`);
      assert.deepEqual((await runtime.query(`SELECT id::integer, value FROM ${at('invoices')}`)).rows, [
        { id: 1, value: 'a-only' },
      ]);
      await runtime.query(`UPDATE ${at('invoices')} SET value = 'updated' WHERE id = 1`);
      assert.equal((await runtime.query(`SELECT value FROM ${at('invoices')}`)).rows[0].value, 'updated');
      await runtime.query(`DELETE FROM ${at('invoices')} WHERE id = 1`);
      assert.equal((await runtime.query(`SELECT * FROM ${at('invoices')}`)).rowCount, 0);
      for (const client of [runtime, migration, confirmation]) {
        for (const sql of [
          `SELECT * FROM ${bt('tf_memberships')}`,
          `INSERT INTO ${bt('invoices')} (value) VALUES ('attack')`,
          `SELECT nextval('${bt('invoices_id_seq')}')`,
          'SELECT * FROM app.accounts',
          "UPDATE app.accounts SET secret = 'attack'",
          'SELECT * FROM database_management.common_target',
          `SET ROLE ${escapeIdentifier(b.names.customOwner)}`,
          `SET ROLE ${escapeIdentifier(db.owner)}`,
          `ALTER TABLE ${at('tf_memberships')} ADD COLUMN attack text`,
          `ALTER TABLE ${at('tf_table_catalog')} OWNER TO ${escapeIdentifier(a.names.customOwner)}`,
          `DROP SCHEMA ${escapeIdentifier(a.names.schema)} CASCADE`,
          'CREATE TEMP TABLE attack (id integer)',
          'CREATE TABLE public.attack (id integer)',
        ])
          await denied(client, sql);
      }
      for (const sql of [
        `SET ROLE ${escapeIdentifier(a.names.customOwner)}`,
        `SET ROLE ${escapeIdentifier(a.names.migration)}`,
        `SET ROLE ${escapeIdentifier(a.names.confirmation)}`,
        `SET SESSION AUTHORIZATION ${escapeIdentifier(db.owner)}`,
        `CREATE TABLE ${at('attack')} (id integer)`,
        `INSERT INTO ${at('tf_confirmations')} DEFAULT VALUES`,
        `INSERT INTO ${at('tf_migration_ledger')} DEFAULT VALUES`,
        `INSERT INTO ${at('tf_common_migrations')} VALUES ('9999_forged.sql', 'forged')`,
        `UPDATE ${at('tf_table_catalog')} SET applied_revision = 'forged'`,
        `INSERT INTO ${at('tf_table_catalog')} (id, owning_team_id, physical_table, display_name, target_revision, applied_revision) VALUES ('${randomUUID()}', '${randomUUID()}', 'forged', 'forged', 'fake', 'fake')`,
        `UPDATE ${at('tf_migration_jobs')} SET status = 'applied'`,
        `GRANT ${escapeIdentifier(a.names.customOwner)} TO ${escapeIdentifier(a.names.runtime)}`,
      ])
        await denied(runtime, sql);
      await denied(migration, `CREATE TABLE ${at('not_assumed')} (id integer)`);
      await migration.query(`SET ROLE ${escapeIdentifier(a.names.customOwner)}`);
      await migration.query(`ALTER TABLE ${at('invoices')} ADD COLUMN optional_note text`);
      await migration.query(`CREATE TABLE ${at('future_invoices')} (id bigserial PRIMARY KEY, value text)`);
      await runtime.query(`INSERT INTO ${at('future_invoices')} (value) VALUES ('future')`);
      assert.deepEqual((await runtime.query(`SELECT id::integer, value FROM ${at('future_invoices')}`)).rows, [
        { id: 1, value: 'future' },
      ]);
      for (const sql of [
        `SELECT * FROM ${bt('invoices')}`,
        `SELECT nextval('${bt('invoices_id_seq')}')`,
        `ALTER TABLE ${bt('invoices')} ADD COLUMN attack text`,
        `ALTER TABLE ${at('tf_memberships')} ADD COLUMN attack text`,
        `UPDATE ${at('tf_memberships')} SET role = 'admin'`,
        `INSERT INTO ${at('tf_confirmations')} DEFAULT VALUES`,
        `ALTER TABLE ${at('tf_memberships')} ADD COLUMN custom_reference bigint REFERENCES ${at('invoices')} (id)`,
        `CREATE TABLE ${at('dependency')} (id uuid REFERENCES ${at('tf_memberships')} (id))`,
        `CREATE TABLE ${at('identity_dependency')} (id integer REFERENCES app.accounts (id))`,
        `CREATE TABLE ${at('inherited_attack')} () INHERITS (${at('tf_memberships')})`,
        `CREATE OR REPLACE VIEW ${at('tf_memberships')} AS SELECT * FROM ${at('invoices')}`,
      ])
        await denied(migration, sql);
      await migration.query(`CREATE VIEW ${at('custom_view')} AS SELECT id FROM ${at('tf_memberships')}`);
      await migration.query(`DROP VIEW ${at('custom_view')} CASCADE`);
      assert.equal((await runtime.query(`SELECT * FROM ${at('tf_memberships')}`)).rowCount, 1);
      await migration.query(`CREATE FUNCTION ${at('custom_function')}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
      await denied(runtime, `SELECT ${at('custom_function')}()`);
      await denied(confirmation, `INSERT INTO ${at('tf_migration_ledger')} DEFAULT VALUES`);
      await denied(confirmation, `UPDATE ${at('tf_confirmations')} SET consumed_at = now()`);
      await denied(confirmation, `CREATE TABLE ${at('confirmation_attack')} (id integer)`);
      await denied(confirmation, `SET ROLE ${escapeIdentifier(a.names.customOwner)}`);
      const team = randomUUID();
      const resource = randomUUID();
      const command = randomUUID();
      const job = randomUUID();
      const receipt = randomUUID();
      await runtime.query(`INSERT INTO ${at('tf_teams')} (id, name) VALUES ($1, 'Finance')`, [team]);
      await runtime.query(
        `INSERT INTO ${at('tf_table_catalog')} (id, owning_team_id, physical_table, display_name, target_revision) VALUES ($1, $2, 'invoices', 'Invoices', 'revision-1')`,
        [resource, team],
      );
      await runtime.query(
        `INSERT INTO ${at('tf_authoring_commands')} (id, membership_id, table_id, request_id, change, status) VALUES ($1, $2, $3, 'request-1', '{}', 'accepted')`,
        [command, a.membershipId, resource],
      );
      await runtime.query(
        `INSERT INTO ${at('tf_migration_jobs')} (id, table_id, command_id, membership_id, target_revision) VALUES ($1, $2, $3, $4, 'revision-1')`,
        [job, resource, command, a.membershipId],
      );
      await withMaintenanceTransaction({
        connectionString: db.login(a, 'confirmation'),
        workspaceId: a.id,
        capability: 'confirmation',
        operation: async ({ client }) => {
          await client.query(`SELECT id FROM ${at('tf_authorization_lock')} WHERE id = 1 FOR SHARE`);
          await client.query(
            `INSERT INTO ${at('tf_confirmations')} (id, workspace_id, table_id, migration_id, plan_digest, destructive_effect, membership_id, expires_at) VALUES ($1, $2, $3, $4, 'digest', '{"drop":"note"}', $5, now() + interval '24 hours')`,
            [receipt, a.id, resource, job, a.membershipId],
          );
        },
      });
      await withMaintenanceTransaction({
        connectionString: db.login(a, 'migration'),
        workspaceId: a.id,
        capability: 'migration',
        operation: async ({ client }) => {
          await client.query(`SELECT id FROM ${at('tf_authorization_lock')} WHERE id = 1 FOR SHARE`);
          await client.query(`SELECT id FROM ${at('tf_table_catalog')} WHERE id = $1 FOR UPDATE`, [resource]);
          await client.query(
            `UPDATE ${at('tf_table_catalog')} SET applied_revision = 'revision-1', applied_definition = '{}' WHERE id = $1`,
            [resource],
          );
          await client.query(`UPDATE ${at('tf_migration_jobs')} SET status = 'applied' WHERE id = $1`, [job]);
          await client.query(`UPDATE ${at('tf_confirmations')} SET consumed_at = now() WHERE id = $1`, [receipt]);
          await client.query(
            `INSERT INTO ${at('tf_migration_ledger')} (migration_id, table_id, applied_revision, plan_digest, confirmation_id) VALUES ($1, $2, 'revision-1', 'digest', $3)`,
            [job, resource, receipt],
          );
        },
      });
      assert.equal(
        (await runtime.query(`SELECT applied_revision FROM ${at('tf_migration_ledger')}`)).rows[0].applied_revision,
        'revision-1',
      );
      await denied(migration, `UPDATE ${at('tf_migration_ledger')} SET applied_revision = 'forged'`);
      await db.platform.query('GRANT SELECT ON app.accounts TO PUBLIC');
      await assert.rejects(verifyWorkspaceIsolation(db.platform, a.id), /ambient privileges/);
      await db.platform.query('REVOKE SELECT ON app.accounts FROM PUBLIC');
      await db.platform.query(
        "CREATE FUNCTION public.ambient_function() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'",
      );
      await db.platform.query('GRANT EXECUTE ON FUNCTION public.ambient_function() TO PUBLIC');
      await assert.rejects(verifyWorkspaceIsolation(db.platform, a.id), /ambient privileges/);
      await db.platform.query('REVOKE EXECUTE ON FUNCTION public.ambient_function() FROM PUBLIC');
      await verifyWorkspaceIsolation(db.platform, a.id);
      await db.platform.query(`CREATE TABLE ${at('tf_future_common')} (id bigserial PRIMARY KEY)`);
      await denied(runtime, `SELECT * FROM ${at('tf_future_common')}`);
      await denied(runtime, `SELECT nextval('${at('tf_future_common_id_seq')}')`);
      const owners = await db.platform.query(
        "SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname LIKE 'tf_%'",
        [a.names.schema],
      );
      assert.deepEqual(owners.rows, [{ owner: db.owner }]);
      await runtime.query(`UPDATE ${at('tf_memberships')} SET removed_at = now() WHERE id = $1`, [a.membershipId]);
      await provisionWorkspace({
        connectionString: db.connectionString,
        workspaceId: a.id,
        passwords: a.passwords,
        initialAdmin: { userId: a.userId, membershipId: randomUUID() },
      });
      assert.equal((await runtime.query(`SELECT * FROM ${at('tf_memberships')} WHERE removed_at IS NULL`)).rowCount, 0);
    } finally {
      await Promise.all(clients.map(client => client.end()));
      await db.close();
    }
  },
);
