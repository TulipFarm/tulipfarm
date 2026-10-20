import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import { inTransaction, type SqlClient } from '@tulipfarm/workspace-storage/provisioning';
import { grantTableRegistryAccess, modelBundleRoutines } from '@tulipfarm/workspaces/table-registry';
import { DatabaseError } from './config.ts';

export function storageCapability() {
  const capability = process.env.WORKSPACE_STORAGE_CAPABILITY;
  if (capability === undefined || capability === '' || capability === 'disabled') return 'disabled';
  if (capability === 'isolated-v1') return capability;
  throw new DatabaseError('Unsupported workspace storage capability.');
}

async function repairApplicationDefaults(client: SqlClient) {
  const currentRole = (await client.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user;
  if (!currentRole) throw new DatabaseError('Missing database role.');
  await client.query('SET LOCAL ROLE NONE');
  const creators = await client.query<{
    creator: string;
  }>(`SELECT DISTINCT pg_catalog.pg_get_userbyid(defaults.defaclrole) AS creator
    FROM pg_catalog.pg_default_acl AS defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS privilege
    WHERE privilege.grantee = 'tulipfarm'::regrole
      AND defaults.defaclobjtype IN ('r', 'S')
      AND (defaults.defaclnamespace = 0 OR defaults.defaclnamespace = 'app'::regnamespace)`);
  for (const { creator } of creators.rows) {
    for (const scope of ['', 'IN SCHEMA app']) {
      try {
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} ${scope} REVOKE ALL ON TABLES FROM tulipfarm`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} ${scope} REVOKE ALL ON SEQUENCES FROM tulipfarm`,
        );
      } catch (cause) {
        throw new DatabaseError(
          `Cannot repair application default privileges for creator ${creator}. Run with authority over this role before continuing.`,
          { cause },
        );
      }
    }
  }
  await client.query(`SET LOCAL ROLE ${escapeIdentifier(currentRole)}`);
}

export async function grantApplicationAccess(
  client: SqlClient,
  requestedCapability: ReturnType<typeof storageCapability>,
) {
  await client.query('CREATE SCHEMA IF NOT EXISTS database_management');
  await client.query(`CREATE TABLE IF NOT EXISTS database_management.storage_capabilities (
    capability text PRIMARY KEY CHECK (capability = 'isolated-v1'),
    installed_at timestamptz NOT NULL DEFAULT now()
  )`);
  if (requestedCapability === 'isolated-v1') {
    await client.query(
      "INSERT INTO database_management.storage_capabilities (capability) VALUES ('isolated-v1') ON CONFLICT DO NOTHING",
    );
  }
  const installed = await client.query(
    "SELECT 1 FROM database_management.storage_capabilities WHERE capability = 'isolated-v1'",
  );
  const capability = installed.rowCount ? 'isolated-v1' : 'disabled';
  const applicationRoutines = [
    'app.acquire_knowledge_embedding_capacity(uuid,text,integer,uuid)',
    ...modelBundleRoutines,
  ];
  if ((await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tulipfarm'")).rowCount) {
    for (const routine of applicationRoutines)
      if ((await client.query('SELECT pg_catalog.to_regprocedure($1) AS routine', [routine])).rows[0]?.routine) {
        await client.query(`GRANT EXECUTE ON FUNCTION ${routine} TO tulipfarm`);
      }
  }
  // Registry logins outlive the app schema; a schema rebuild drops their grants, so every migrate run restores them.
  const registries = await client.query<{
    rolname: string;
    marker: string;
  }>(`SELECT rolname, pg_catalog.shobj_description(oid, 'pg_authid') AS marker
    FROM pg_catalog.pg_roles WHERE pg_catalog.shobj_description(oid, 'pg_authid') LIKE 'tulipfarm.table-registry.%'`);
  for (const { rolname, marker } of registries.rows) {
    const capability = marker.slice('tulipfarm.table-registry.'.length);
    if (capability === 'authoring' || capability === 'confirmation' || capability === 'migration')
      await grantTableRegistryAccess(client, rolname, capability);
  }
  const role = await client.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tulipfarm' AND CURRENT_USER <> 'tulipfarm'",
  );
  if (!role.rowCount) return;
  await client.query('REVOKE ALL ON SCHEMA database_management FROM PUBLIC, tulipfarm');
  await client.query('REVOKE ALL ON database_management.storage_capabilities FROM PUBLIC, tulipfarm');
  await repairApplicationDefaults(client);
  await client.query('GRANT USAGE ON SCHEMA app TO tulipfarm');
  await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM tulipfarm');
  await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM tulipfarm');
  const grants = [
    { table: 'users', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
    { table: 'user_visits', privileges: 'SELECT, INSERT, UPDATE (user_id)' },
    { table: 'sessions', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
    { table: 'accounts', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
    { table: 'verifications', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
    { table: 'email_deliveries', privileges: 'SELECT, INSERT, UPDATE' },
    { table: 'api_rate_limits', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
    { table: 'model_route_health', privileges: 'SELECT, INSERT, UPDATE' },
    { table: 'model_route_health_claims', privileges: 'SELECT, INSERT, DELETE' },
    { table: 'platform_recommendation_budget_policy', privileges: 'SELECT, INSERT, UPDATE' },
    { table: 'platform_recommendation_budget_counters', privileges: 'SELECT, INSERT, UPDATE' },
    { table: 'platform_recommendation_attempts', privileges: 'SELECT, INSERT, UPDATE' },
    { table: 'github_event_policy', privileges: 'SELECT, INSERT' },
    { table: 'github_event_routes', privileges: 'SELECT, INSERT, UPDATE (generation, active)' },
    { table: 'github_event_deliveries', privileges: 'SELECT, INSERT, UPDATE (status, reason)' },
    { table: 'github_event_payloads', privileges: 'SELECT, INSERT, DELETE' },
    {
      table: 'github_event_dispatches',
      privileges: 'SELECT, INSERT, UPDATE (status, reason, lease_id, lease_until, completed_lease_id, next_attempt_at)',
    },
    { table: 'onboarding_drafts', privileges: 'SELECT, INSERT, UPDATE (claimed_by), DELETE' },
    {
      table: 'slack_workspace_links',
      privileges:
        'SELECT, INSERT, UPDATE (team_id, generation, state, state_hash, session_id, user_id, membership_id, expires_at)',
    },
    {
      table: 'workspaces',
      privileges:
        capability === 'disabled'
          ? 'SELECT, INSERT, UPDATE, DELETE'
          : 'SELECT (id, request_id, created_by, name, slug, created_at, soul_commit, soul_bucket, soul_key, ready_at), INSERT (request_id, created_by, name, slug)',
    },
    {
      table: 'workspace_storage',
      privileges:
        'SELECT (workspace_id, generation, stage, runtime_credential, error_code, updated_at), INSERT (workspace_id)',
    },
    ...(capability === 'disabled'
      ? [{ table: 'workspace_memberships', privileges: 'SELECT, INSERT, UPDATE, DELETE' }]
      : []),
  ];
  for (const { table, privileges } of grants) {
    const exists = await client.query('SELECT pg_catalog.to_regclass($1) AS relation', [`app.${table}`]);
    if (exists.rows[0]?.relation)
      await client.query(`GRANT ${privileges} ON app.${escapeIdentifier(table)} TO tulipfarm`);
  }
  // Fresh installs grant after each migration, before later migrations add these columns.
  if (
    capability !== 'disabled' &&
    (
      await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'workspaces' AND column_name = 'icon'",
      )
    ).rowCount
  ) {
    await client.query('GRANT SELECT (icon), INSERT (icon) ON app.workspaces TO tulipfarm');
  }
  if (
    (
      await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'workspaces' AND column_name = 'creation_name'",
      )
    ).rowCount
  ) {
    await client.query('GRANT SELECT (creation_name, settings_revision) ON app.workspaces TO tulipfarm');
    await client.query('GRANT SELECT ON app.workspace_settings_commands TO tulipfarm');
  }
}

export async function connect(url: string) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 15000, statement_timeout: 60000 });
  client.on('error', () => {
    process.stderr.write('PostgreSQL connection interrupted.\n');
  });
  await client.connect();
  return client;
}

export async function bootstrap(adminUrl: string, passwords: { owner: string; application: string; temporal: string }) {
  const capability = storageCapability();
  const admin = await connect(adminUrl);
  try {
    await admin.query('SELECT pg_advisory_lock(734128, 1)');
    for (const [name, password] of [
      ['tulipfarm_owner', passwords.owner],
      ['tulipfarm', passwords.application],
      ['temporal', passwords.temporal],
    ]) {
      if (!name || !password) throw new Error('Missing role configuration');
      const result = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
      if (!result.rowCount) await admin.query(`CREATE ROLE ${escapeIdentifier(name)} LOGIN`);
      await admin.query(
        `ALTER ROLE ${escapeIdentifier(name)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${escapeLiteral(password)}`,
      );
    }
    const user = await admin.query<{ current_user: string }>('SELECT current_user');
    const administrator = user.rows[0]?.current_user;
    if (!administrator) throw new Error('Missing database administrator');
    await admin.query(`GRANT tulipfarm_owner, temporal TO ${escapeIdentifier(administrator)}`);
    for (const [database, owner] of [
      ['tulipfarm', 'tulipfarm_owner'],
      ['temporal', 'temporal'],
      ['temporal_visibility', 'temporal'],
    ]) {
      if (!database || !owner) throw new Error('Missing database configuration');
      const result = await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [
        database,
      ]);
      if (!result.rowCount)
        await admin.query(`CREATE DATABASE ${escapeIdentifier(database)} OWNER ${escapeIdentifier(owner)}`);
      else if (result.rows[0]?.owner !== owner) throw new Error(`Unexpected owner for ${database}`);
      await admin.query(`REVOKE ALL ON DATABASE ${escapeIdentifier(database)} FROM PUBLIC`);
    }
    await admin.query('GRANT CONNECT ON DATABASE tulipfarm TO tulipfarm');
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  // Azure makes azure_pg_admin, not the database owner, own each database's public schema.
  for (const database of ['temporal', 'temporal_visibility']) {
    url.pathname = `/${database}`;
    const temporal = await connect(url.href);
    try {
      await temporal.query('GRANT USAGE, CREATE ON SCHEMA public TO temporal');
    } finally {
      await temporal.end();
    }
  }
  url.pathname = '/tulipfarm';
  const app = await connect(url.href);
  try {
    await app.query('SET ROLE tulipfarm_owner');
    await app.query('SELECT pg_advisory_lock(734128, 2)');
    await inTransaction(app, async transaction => {
      await transaction.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await transaction.query('CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION tulipfarm_owner');
      await grantApplicationAccess(transaction, capability);
    });
  } finally {
    await app.end();
  }
}
