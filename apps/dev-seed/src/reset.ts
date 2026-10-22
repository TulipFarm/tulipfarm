import pg from 'pg';
import { workspaceNames } from '@tulipfarm/workspace-storage/provisioning';
import { SeedRefused, assertLoopback } from './env.ts';
import type { Manifest } from './manifest.ts';
import { seedEmailDomain, seedSlugPrefix } from './workspace.ts';

// Workspace roles and schemas need a superuser to drop; the compose stack's superuser is the local default.
const defaultAdminUrl = 'postgresql://postgres:local-postgres@127.0.0.1:5432/tulipfarm';
// Mirrors removeRoles in apps/database/src/workspace-operations-lifecycle.ts: every privilege held by a workspace role, grouped by grantor.
const roleGrants = `SELECT grantor.rolname AS grantor, format('REVOKE %s ON %s FROM %I',
    string_agg(DISTINCT a.privilege_type || CASE WHEN d.objsubid = 0 THEN '' ELSE format(' (%I)', attribute.attname) END, ', '),
    target.name, grantee.rolname) AS statement
  FROM pg_shdepend d JOIN pg_roles grantee ON grantee.oid = d.refobjid
  CROSS JOIN LATERAL aclexplode(pg_get_acl(d.classid, d.objid, d.objsubid)) a JOIN pg_roles grantor ON grantor.oid = a.grantor
  LEFT JOIN pg_attribute attribute ON d.classid = 'pg_class'::regclass AND attribute.attrelid = d.objid AND attribute.attnum = d.objsubid
  CROSS JOIN LATERAL (SELECT CASE d.classid
    WHEN 'pg_namespace'::regclass THEN 'SCHEMA ' || d.objid::regnamespace::text
    WHEN 'pg_type'::regclass THEN 'TYPE ' || d.objid::regtype::text
    WHEN 'pg_proc'::regclass THEN 'ROUTINE ' || d.objid::regprocedure::text
    WHEN 'pg_class'::regclass THEN (SELECT CASE relkind WHEN 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END FROM pg_class WHERE oid = d.objid) || d.objid::regclass::text
    WHEN 'pg_database'::regclass THEN 'DATABASE ' || (SELECT quote_ident(datname) FROM pg_database WHERE oid = d.objid)
  END AS name) target
  WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'a' AND a.grantee = d.refobjid AND grantee.rolname = ANY($1)
    AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())) AND target.name IS NOT NULL
  GROUP BY grantor.rolname, target.name, grantee.rolname, d.objsubid ORDER BY grantor.rolname, target.name, d.objsubid`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function adminDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const value = env.DEV_SEED_ADMIN_DATABASE_URL ?? defaultAdminUrl;
  assertLoopback('DEV_SEED_ADMIN_DATABASE_URL', value);
  return value;
}

export async function resetSeed(
  manifest: Manifest,
  input: { slugs: string[] | 'all'; users: boolean },
  log: (message: string) => void,
) {
  if (input.slugs !== 'all')
    for (const slug of input.slugs)
      if (!slug.startsWith(seedSlugPrefix))
        throw new SeedRefused(`Refusing to reset ${slug}: only ${seedSlugPrefix}* workspaces are seeded.`);
  const client = new pg.Client({ connectionString: adminDatabaseUrl() });
  await client.connect();
  try {
    const rows = (
      await client.query<{ id: string; slug: string }>(
        input.slugs === 'all'
          ? 'SELECT id, slug FROM app.workspaces WHERE slug LIKE $1 ORDER BY slug'
          : 'SELECT id, slug FROM app.workspaces WHERE slug = ANY($1) ORDER BY slug',
        [input.slugs === 'all' ? `${seedSlugPrefix}%` : input.slugs],
      )
    ).rows;
    const tables = (
      await client.query<{
        name: string;
      }>(`SELECT format('%I.%I', table_schema, table_name) AS name FROM information_schema.columns
      WHERE column_name = 'workspace_id' AND table_schema NOT LIKE 'ws\\_%' AND table_name <> 'workspaces' AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_name = 'workspace_storage', table_name`)
    ).rows.map(row => row.name);
    for (const row of rows) {
      const names = workspaceNames(row.id);
      const roles = [names.runtime, names.migration, names.confirmation, names.customOwner];
      await client.query('BEGIN');
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${quote(names.schema)} CASCADE`);
        const existing = (
          await client.query<{ name: string; marker: string | null }>(
            "SELECT rolname AS name, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ANY($1)",
            [roles],
          )
        ).rows;
        if (existing.some(role => role.marker !== `tulipfarm.workspace.${names.workspaceId}`))
          throw new Error(`Workspace roles for ${row.slug} are not marked as its own; leaving them in place.`);
        // Other roles granted these privileges, so each grant is revoked as its grantor.
        const grants = (await client.query<{ grantor: string; statement: string }>(roleGrants, [roles])).rows;
        for (const grant of grants) {
          await client.query(`SET LOCAL ROLE ${quote(grant.grantor)}`);
          await client.query(grant.statement);
          await client.query('RESET ROLE');
        }
        for (const role of existing) await client.query(`DROP OWNED BY ${quote(role.name)} CASCADE`);
        for (const role of existing) await client.query(`DROP ROLE ${quote(role.name)}`);
        for (const table of tables) await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [row.id]);
        await client.query('DELETE FROM app.workspaces WHERE id = $1', [row.id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      delete manifest.workspaces[row.slug];
      log(`Removed ${row.slug}`);
    }
    const missing = input.slugs === 'all' ? [] : input.slugs.filter(slug => !rows.some(row => row.slug === slug));
    for (const slug of missing) {
      delete manifest.workspaces[slug];
      log(`${slug} was not in the database`);
    }
    if (input.slugs === 'all') for (const slug of Object.keys(manifest.workspaces)) delete manifest.workspaces[slug];
    if (input.users) {
      // A seeded user who still belongs to a hand-made workspace keeps their account.
      const removed = (
        await client.query<{ email: string }>(
          `DELETE FROM app.users u WHERE u.email LIKE $1
        AND NOT EXISTS (SELECT 1 FROM app.workspace_memberships m WHERE m.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM app.workspaces w WHERE w.created_by = u.id)
        AND NOT EXISTS (SELECT 1 FROM app.workspace_settings_commands c WHERE c.user_id = u.id) RETURNING email`,
          [`%@${seedEmailDomain}`],
        )
      ).rows;
      for (const user of removed) {
        delete manifest.users[user.email];
        log(`Removed user ${user.email}`);
      }
    }
    return rows.length;
  } finally {
    await client.end();
  }
}
