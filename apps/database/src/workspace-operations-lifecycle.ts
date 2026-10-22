import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import {
  inTransaction,
  lockWorkspaceMigration,
  workspaceNames,
  type SqlClient,
} from '@tulipfarm/workspace-storage/provisioning';
import { connect } from './postgres.ts';
import { disposableDatabase } from './workspace-operations-recovery.ts';

export type WorkspaceLifecycle = {
  markUnavailable: (workspaceId: string, operatorId: string) => Promise<void>;
  stopJobs: (workspaceId: string) => Promise<void>;
  drainPools: (workspaceId: string) => Promise<void>;
  assertUnavailable: (workspaceId: string) => Promise<void>;
};

const removalOrder = ['view', 'materialized view', 'table', 'sequence', 'routine', 'domain', 'type'] as const;
type RemovableKind = (typeof removalOrder)[number];
const schemaObjectsSchema = z.array(z.object({ kind: z.enum([...removalOrder, 'unsupported']), name: z.string() }));
const roleGrantsSchema = z.array(z.object({ grantor: z.string(), statement: z.string() }));

async function schemaObjects(client: SqlClient, schema: string) {
  return schemaObjectsSchema.parse(
    (
      await client.query(
        `WITH objects AS (
      SELECT 'pg_class'::regclass AS catalog, c.oid, format('%I.%I', n.nspname, c.relname) AS name,
        CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence' ELSE 'unsupported' END AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S')
      UNION ALL SELECT 'pg_proc'::regclass, p.oid, format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), 'routine'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1
      UNION ALL SELECT 'pg_type'::regclass, t.oid, format('%I.%I', n.nspname, t.typname), CASE t.typtype WHEN 'd' THEN 'domain' ELSE 'type' END
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1)
    SELECT kind, name FROM objects o
    WHERE NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = o.catalog AND d.objid = o.oid AND d.deptype = 'i')
    UNION ALL SELECT 'unsupported', d.classid::regclass::text FROM pg_depend d JOIN pg_namespace n ON n.oid = d.refobjid
    WHERE d.refclassid = 'pg_namespace'::regclass AND n.nspname = $1 AND d.deptype = 'n'
      AND d.classid NOT IN ('pg_class'::regclass, 'pg_proc'::regclass, 'pg_type'::regclass)
    ORDER BY kind, name`,
        [schema],
      )
    ).rows,
  );
}

async function dropRestricted(client: SqlClient, kind: RemovableKind, names: string[]) {
  await client.query('SAVEPOINT scoped_remove');
  let dropped = true;
  try {
    await client.query(`DROP ${kind.toUpperCase()} IF EXISTS ${names.join(', ')} RESTRICT`);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT scoped_remove');
    if (typeof error !== 'object' || !error || !('code' in error) || error.code !== '2BP01') throw error;
    dropped = false;
  }
  await client.query('RELEASE SAVEPOINT scoped_remove');
  return dropped;
}

async function removeSchema(client: SqlClient, schema: string) {
  let pending = await schemaObjects(client, schema);
  if (pending.some(object => object.kind === 'unsupported')) throw new Error('unsupported-workspace-dependency');
  while (pending.length) {
    for (const kind of removalOrder) {
      const group = pending.flatMap(object => (object.kind === kind ? [object.name] : []));
      if (group.length && !(await dropRestricted(client, kind, group))) {
        for (const name of group) await dropRestricted(client, kind, [name]);
      }
    }
    const remaining = await schemaObjects(client, schema);
    if (remaining.length >= pending.length) throw new Error('workspace-external-dependency');
    pending = remaining;
  }
  await client.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} RESTRICT`);
}

async function removeRoles(client: SqlClient, roles: string[], customOwner: string) {
  const grants = roleGrantsSchema.parse(
    (
      await client.query(
        `SELECT grantor.rolname AS grantor, format('REVOKE %s ON %s FROM %I',
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
    GROUP BY grantor.rolname, target.name, grantee.rolname, d.objsubid ORDER BY grantor.rolname, target.name, d.objsubid`,
        [roles],
      )
    ).rows,
  );
  for (const grant of grants) {
    await client.query(`SET LOCAL ROLE ${escapeIdentifier(grant.grantor)}`);
    await client.query(grant.statement);
  }
  await client.query('RESET ROLE');
  if (roles.includes(customOwner)) {
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(customOwner)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(customOwner)} GRANT USAGE ON TYPES TO PUBLIC`,
    );
  }
  for (const role of roles) await client.query(`DROP ROLE ${escapeIdentifier(role)}`);
}

async function verifyRoles(client: SqlClient, workspaceId: string) {
  const names = workspaceNames(workspaceId);
  const roles = [names.runtime, names.migration, names.confirmation, names.customOwner];
  const rows = z
    .array(z.object({ name: z.string(), marker: z.string().nullable() }))
    .parse(
      (
        await client.query(
          "SELECT rolname AS name, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ANY($1)",
          [roles],
        )
      ).rows,
    );
  if (rows.some(row => row.marker !== `tulipfarm.workspace.${names.workspaceId}`))
    throw new Error('workspace-role-drift');
  return { names, roles: rows.map(row => row.name) };
}

export async function workspaceOperationStatus(client: SqlClient, workspaceId: string) {
  const { names, roles } = await verifyRoles(client, workspaceId);
  const schemaExists = Boolean(
    (await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [names.schema])).rowCount,
  );
  const sessions = z
    .object({ count: z.number() })
    .parse(
      (await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename = ANY($1)', [roles]))
        .rows[0],
    ).count;
  const registryExists = (await client.query("SELECT to_regclass('app.workspace_storage') AS relation")).rows[0]
    ?.relation;
  const lifecycle = registryExists
    ? z
        .object({ stage: z.string(), generation: z.number() })
        .nullable()
        .parse(
          (
            await client.query('SELECT stage, generation FROM app.workspace_storage WHERE workspace_id=$1', [
              names.workspaceId,
            ])
          ).rows[0] ?? null,
        )
    : null;
  return { workspaceId, schemaExists, lifecycle, sessions };
}

export async function quiesceWorkspace(options: {
  client: SqlClient;
  workspaceId: string;
  operatorId: string;
  lifecycle: WorkspaceLifecycle;
}) {
  z.string().min(1).parse(options.operatorId);
  await verifyRoles(options.client, options.workspaceId);
  await options.lifecycle.markUnavailable(options.workspaceId, options.operatorId);
  await options.lifecycle.assertUnavailable(options.workspaceId);
  const { roles } = await verifyRoles(options.client, options.workspaceId);
  for (const role of roles) await options.client.query(`ALTER ROLE ${escapeIdentifier(role)} NOLOGIN`);
  await options.client.query(
    'SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE usename = ANY($1) AND pid <> pg_backend_pid()',
    [roles],
  );
  await options.lifecycle.stopJobs(options.workspaceId);
  await options.lifecycle.drainPools(options.workspaceId);
  const status = await workspaceOperationStatus(options.client, options.workspaceId);
  if (status.sessions) throw new Error('workspace-sessions-not-drained');
  return status;
}

export async function teardownDisposableWorkspace(options: {
  connectionString: string;
  workspaceId: string;
  operatorId: string;
  lifecycle: WorkspaceLifecycle;
}) {
  disposableDatabase(options.connectionString);
  const client = await connect(options.connectionString);
  try {
    await quiesceWorkspace({ ...options, client });
    await options.lifecycle.assertUnavailable(options.workspaceId);
    const { names, roles } = await verifyRoles(client, options.workspaceId);
    await inTransaction(client, async transaction => {
      await lockWorkspaceMigration(transaction, options.workspaceId);
      await removeSchema(transaction, names.schema);
      if ((await transaction.query("SELECT to_regclass('app.email_deliveries') AS relation")).rows[0]?.relation) {
        await transaction.query(
          "UPDATE app.email_deliveries SET status = 'cancelled', payload = NULL, lease_until = NULL WHERE workspace_id = $1 AND payload IS NOT NULL",
          [options.workspaceId],
        );
      }
      await removeRoles(transaction, roles, names.customOwner);
    });
    return { workspaceId: options.workspaceId, status: 'removed' as const };
  } finally {
    await client.end();
  }
}
