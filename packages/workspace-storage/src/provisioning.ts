import { escapeIdentifier, escapeLiteral } from 'pg';
import { creditGate } from '@tulipfarm/extensions';
import { z } from 'zod';
import { commonTables, qualified, workspaceNames } from './names.ts';
import {
  applyCommonMigrations,
  connectMaintenance,
  lockRolloutTarget,
  lockWorkspaceMigration,
  readMigrations,
  type Migration,
} from './migrations.ts';
import { inTransaction, type SqlClient } from './transactions.ts';
import { fenceWorkspaceAccess } from './runtime.ts';
import { auditedOnlineCaptureFunctions } from './online-capture.ts';
import { auditedPgvectorFunctions, pgvectorExtensionFunctions } from './pgvector.ts';
import { withErrorStage } from '@tulipfarm/observability';

export { auditedPgvectorFunctions, grantPgvector, pgvectorExtensionFunctions } from './pgvector.ts';

export { onlineCaptureBody } from './online-capture.ts';

export { commonTables, qualified, tableTableName, workspaceIdSchema, workspaceNames } from './names.ts';
export {
  applyCommonMigrations,
  applyMigrationStream,
  assertPublishedTarget,
  commonMigrationDirectory,
  connectMaintenance,
  lockWorkspaceMigration,
  migrationTarget,
  readMigrations,
  rolloutCommonMigrations,
  MigrationDriftError,
  StaleRolloutTargetError,
  PendingTableWorkError,
} from './migrations.ts';
export type { Migration, RolloutResult } from './migrations.ts';
export { inTransaction } from './transactions.ts';
export type { SqlClient } from './transactions.ts';

const passwordsSchema = z.object({
  runtime: z.string().min(24),
  migration: z.string().min(24),
  confirmation: z.string().min(24),
});
const identitySchema = z.object({ current_user: z.string(), database: z.string() });
const roleSchema = z.object({
  rolname: z.string(),
  marker: z.string().nullable(),
  rolsuper: z.boolean(),
  rolcreatedb: z.boolean(),
  rolcreaterole: z.boolean(),
  rolreplication: z.boolean(),
  rolbypassrls: z.boolean(),
});

export async function provisionWorkspace(options: {
  connectionString: string;
  workspaceId: string;
  passwords: z.infer<typeof passwordsSchema>;
  initialAdmin: { userId: string; membershipId: string };
  migrations?: readonly Migration[];
}) {
  const names = workspaceNames(options.workspaceId);
  const passwords = passwordsSchema.parse(options.passwords);
  const initialAdmin = z.object({ userId: z.string().min(1), membershipId: z.uuid() }).parse(options.initialAdmin);
  const migrations = options.migrations ?? (await readMigrations());
  const client = await connectMaintenance(options.connectionString);
  try {
    await inTransaction(
      client,
      async transaction => {
        await lockRolloutTarget(transaction, migrations);
        await lockWorkspaceMigration(transaction, names.workspaceId);
        const identity = identitySchema.parse(
          (await transaction.query('SELECT current_user, current_database() AS database')).rows[0],
        );
        const owner = escapeIdentifier(identity.current_user);
        const database = escapeIdentifier(identity.database);
        const schema = escapeIdentifier(names.schema);
        const marker = `tulipfarm.workspace.${names.workspaceId}`;
        for (const [capability, roleName] of Object.entries({
          runtime: names.runtime,
          migration: names.migration,
          confirmation: names.confirmation,
          customOwner: names.customOwner,
        })) {
          const role = escapeIdentifier(roleName);
          const existing = z
            .array(roleSchema)
            .parse(
              (
                await transaction.query(
                  "SELECT rolname, shobj_description(oid, 'pg_authid') AS marker, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
                  [roleName],
                )
              ).rows,
            );
          if (
            existing.some(
              item =>
                item.marker !== marker ||
                item.rolsuper ||
                item.rolcreatedb ||
                item.rolcreaterole ||
                item.rolreplication ||
                item.rolbypassrls,
            )
          )
            throw new Error('Unexpected workspace role ownership or elevated attributes');
          if (!existing.length) {
            await transaction.query(
              `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
            );
            await transaction.query(`COMMENT ON ROLE ${role} IS ${escapeLiteral(marker)}`);
          }
          const memberships = (
            await transaction.query(
              'SELECT parent.rolname FROM pg_auth_members membership JOIN pg_roles child ON child.oid = membership.member JOIN pg_roles parent ON parent.oid = membership.roleid WHERE child.rolname = $1',
              [roleName],
            )
          ).rows;
          for (const membership of memberships) {
            const parent = z.object({ rolname: z.string() }).parse(membership);
            if (capability !== 'migration' || parent.rolname !== names.customOwner)
              throw new Error('Unexpected workspace role membership');
          }
          if (capability === 'customOwner') {
            await transaction.query(`ALTER ROLE ${role} NOLOGIN NOINHERIT`);
          } else {
            const password = passwordsSchema.shape.runtime.parse(Reflect.get(passwords, capability));
            await transaction.query(`ALTER ROLE ${role} LOGIN NOINHERIT PASSWORD ${escapeLiteral(password)}`);
            await transaction.query(`ALTER ROLE ${role} SET search_path TO pg_catalog`);
            await transaction.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
          }
          await transaction.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM ${role}`);
        }
        await transaction.query(`GRANT ${escapeIdentifier(names.customOwner)} TO ${owner} WITH INHERIT TRUE, SET TRUE`);
        await transaction.query(
          `GRANT ${escapeIdentifier(names.customOwner)} TO ${escapeIdentifier(names.migration)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
        await transaction.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
        await transaction.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        const existingSchema = (
          await transaction.query('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1', [
            names.schema,
          ])
        ).rows;
        if (
          existingSchema.length &&
          z.object({ owner: z.string() }).parse(existingSchema[0]).owner !== identity.current_user
        )
          throw new Error('Unexpected workspace schema owner');
        await transaction.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${owner}`);
        await transaction.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
        for (const roleName of [names.runtime, names.migration, names.confirmation, names.customOwner]) {
          await transaction.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${escapeIdentifier(roleName)}`);
          await transaction.query(`GRANT USAGE ON SCHEMA ${schema} TO ${escapeIdentifier(roleName)}`);
        }
        await transaction.query(`GRANT CREATE ON SCHEMA ${schema} TO ${escapeIdentifier(names.customOwner)}`);
        for (const creator of [identity.current_user, names.customOwner]) {
          for (const objects of ['TABLES', 'SEQUENCES', 'FUNCTIONS', 'TYPES']) {
            const recipients = `PUBLIC, ${[names.runtime, names.migration, names.confirmation, names.customOwner]
              .filter(role => role !== creator)
              .map(escapeIdentifier)
              .join(', ')}`;
            await transaction.query(
              `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} REVOKE ALL ON ${objects} FROM ${recipients}`,
            );
            await transaction.query(
              `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} IN SCHEMA ${schema} REVOKE ALL ON ${objects} FROM ${recipients}`,
            );
          }
        }
        await transaction.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(names.customOwner)} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${escapeIdentifier(names.runtime)}`,
        );
        await transaction.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(names.customOwner)} IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${escapeIdentifier(names.runtime)}`,
        );
        const unexpectedDefaults = await transaction.query(
          `SELECT 1 FROM pg_default_acl d
        JOIN pg_roles creator ON creator.oid = d.defaclrole
        CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
        WHERE creator.rolname = ANY($1::text[]) AND (d.defaclnamespace = 0 OR d.defaclnamespace = $2::regnamespace)
          AND acl.grantee <> d.defaclrole
          AND NOT (creator.rolname = $3 AND d.defaclnamespace = $2::regnamespace
            AND acl.grantee = $4::regrole AND NOT acl.is_grantable
            AND ((d.defaclobjtype = 'r' AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
              OR (d.defaclobjtype = 'S' AND acl.privilege_type IN ('USAGE', 'SELECT')))) LIMIT 1`,
          [[identity.current_user, names.customOwner], names.schema, names.customOwner, names.runtime],
        );
        if (unexpectedDefaults.rowCount)
          throw new Error('Unexpected creator default privileges require explicit reconciliation');
        await applyCommonMigrations(transaction, names.workspaceId, migrations);
        if (
          (
            await transaction.query(
              "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'workspace_access'",
            )
          ).rowCount
        ) {
          for (const role of [names.runtime, names.migration, names.confirmation]) {
            await transaction.query(`GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(role)}`);
            await transaction.query(
              `GRANT EXECUTE ON FUNCTION app.workspace_access(uuid, boolean) TO ${escapeIdentifier(role)}`,
            );
          }
          await transaction.query(
            `GRANT EXECUTE ON FUNCTION app.workspace_settings(uuid, uuid, uuid, jsonb) TO ${escapeIdentifier(names.runtime)}`,
          );
          await grantWorkspaceSettingsAuthority(transaction, names.workspaceId);
        }
        await creditGate().provision?.({ client: transaction, schema: names.schema });
        await verifyWorkspaceIsolation(transaction, names.workspaceId);
        const initialized = await transaction.query(
          `INSERT INTO ${qualified(names.schema, commonTables.provisioning)} (id, workspace_id) VALUES (1, $1) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [names.workspaceId],
        );
        if (initialized.rowCount) {
          await transaction.query(
            `INSERT INTO ${qualified(names.schema, commonTables.memberships)} (id, user_id, role) VALUES ($1, $2, 'admin')`,
            [initialAdmin.membershipId, initialAdmin.userId],
          );
          await transaction.query(
            `INSERT INTO ${qualified(names.schema, commonTables.memberTeams)} (membership_id, team_id) SELECT $1, id FROM ${qualified(names.schema, commonTables.teams)} WHERE name = '_admin'`,
            [initialAdmin.membershipId],
          );
        }
      },
      { statementTimeoutMs: 60_000 },
    );
    return names;
  } finally {
    await client.end();
  }
}

export async function grantWorkspaceSettingsAuthority(client: SqlClient, workspaceId: string) {
  const names = workspaceNames(workspaceId);
  const { owner } = z
    .object({ owner: z.string() })
    .parse(
      (
        await client.query(
          "SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = to_regprocedure('app.workspace_settings(uuid,uuid,uuid,jsonb)')",
        )
      ).rows[0],
    );
  const role = escapeIdentifier(owner);
  await client.query(`GRANT USAGE ON SCHEMA ${escapeIdentifier(names.schema)} TO ${role}`);
  await client.query(
    `GRANT SELECT ON ${qualified(names.schema, commonTables.memberships)}, ${qualified(names.schema, commonTables.authorizationLock)} TO ${role}`,
  );
  await client.query(
    `GRANT UPDATE(lock_version) ON ${qualified(names.schema, commonTables.authorizationLock)} TO ${role}`,
  );
  const receiptOwner = (
    await client.query(
      "SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = to_regprocedure('app.model_availability_receipt()')",
    )
  ).rows[0];
  if (
    receiptOwner &&
    (await client.query('SELECT to_regclass($1) AS relation', [qualified(names.schema, 'tf_model_availability')]))
      .rows[0]?.relation
  ) {
    const receiptRole = escapeIdentifier(z.object({ owner: z.string() }).parse(receiptOwner).owner);
    await client.query(`GRANT USAGE ON SCHEMA ${escapeIdentifier(names.schema)} TO ${receiptRole}`);
    await client.query(
      `GRANT SELECT ON ${qualified(names.schema, commonTables.memberships)}, ${qualified(names.schema, commonTables.authorizationLock)}, ${qualified(names.schema, 'tf_model_availability')} TO ${receiptRole}`,
    );
    await client.query(
      `GRANT UPDATE(lock_version) ON ${qualified(names.schema, commonTables.authorizationLock)} TO ${receiptRole}`,
    );
  }
  const profileOwner = (
    await client.query(
      "SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=to_regprocedure('app.workspace_member_profiles(uuid,uuid[])')",
    )
  ).rows[0];
  if (
    profileOwner &&
    (
      await client.query('SELECT to_regclass($1) AS relation', [
        qualified(names.schema, commonTables.workspaceMemberAccounts),
      ])
    ).rows[0]?.relation
  ) {
    const profileRole = escapeIdentifier(z.object({ owner: z.string() }).parse(profileOwner).owner);
    await client.query(`GRANT USAGE ON SCHEMA ${escapeIdentifier(names.schema)} TO ${profileRole}`);
    await client.query(
      `GRANT SELECT ON ${qualified(names.schema, commonTables.memberships)}, ${qualified(names.schema, commonTables.workspaceMemberAccounts)}, ${qualified(names.schema, commonTables.authorizationLock)} TO ${profileRole}`,
    );
    await client.query(
      `GRANT UPDATE(lock_version) ON ${qualified(names.schema, commonTables.authorizationLock)} TO ${profileRole}`,
    );
  }
}

export async function verifyWorkspaceIsolation(client: SqlClient, workspaceId: string) {
  const names = workspaceNames(workspaceId);
  const onlineCaptureFunctions = await auditedOnlineCaptureFunctions(client, names.schema, names.customOwner);
  const pgvectorFunctions = await auditedPgvectorFunctions(client);
  const pgvectorExtension = await pgvectorExtensionFunctions(client);
  const commonOwnership = await client.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relowner <> n.nspowner`,
    [names.schema, Object.values(commonTables)],
  );
  if (commonOwnership.rowCount) throw new Error('Common object owner differs from the workspace schema owner');
  for (const role of [names.runtime, names.migration, names.confirmation, names.customOwner]) {
    const violations = await client.query(
      `
      SELECT 'relation' AS kind, n.nspname || '.' || c.relname AS object FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', $2) AND n.nspname NOT LIKE 'pg_toast%'
        AND ((c.relkind IN ('r', 'p', 'v', 'm', 'f') AND (has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          -- Column grants live only in attacl; checking every relation's columns made each provision scale with the workspace count.
          OR (c.oid IN (SELECT attrelid FROM pg_attribute WHERE attacl IS NOT NULL) AND has_any_column_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))))
          OR (c.relkind = 'S' AND has_sequence_privilege($1, c.oid, 'USAGE,SELECT,UPDATE')))
      UNION ALL
      SELECT 'schema', n.nspname FROM pg_namespace n WHERE n.nspname <> $2 AND has_schema_privilege($1, n.oid, 'CREATE')
      UNION ALL
      SELECT 'function', n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND (p.prosecdef OR n.nspname <> $2)
        AND has_schema_privilege($1, n.oid, 'USAGE') AND has_function_privilege($1, p.oid, 'EXECUTE')
        AND NOT ($1=$3 AND p.oid=ANY($6::oid[]) AND NOT has_function_privilege($1,p.oid,'EXECUTE WITH GRANT OPTION'))
        AND NOT (p.oid=ANY($7::oid[]) AND NOT has_function_privilege($1,p.oid,'EXECUTE WITH GRANT OPTION'))
        AND NOT ($1 = $4 AND n.nspname = $2 AND p.proname = 'tf_row_token_changed'
          AND p.proowner = n.nspowner AND p.prorettype = 'pg_catalog.trigger'::regtype AND p.pronargs = 0)
        AND NOT ($1 = $4 AND n.nspname = $2 AND p.oid = ANY($5::oid[]))
        AND NOT (n.nspname = $2 AND p.proowner = n.nspowner
          AND p.prorettype = 'pg_catalog.bool'::regtype AND NOT p.proretset
          AND p.proconfig = ARRAY['search_path=pg_catalog']
          AND ((p.proname = 'tf_table_proposal_capture_current' AND pg_get_function_identity_arguments(p.oid) = 'proposal uuid, resource uuid')
            OR (p.proname = 'tf_table_source_allowed' AND pg_get_function_identity_arguments(p.oid) = 'member_id uuid, actor_user text, source jsonb')
            OR (p.proname = 'tf_table_file_allowed' AND pg_get_function_identity_arguments(p.oid) = 'member_id uuid, actor_user text, file_id uuid')
            OR (p.proname = 'tf_table_attachment_allowed' AND pg_get_function_identity_arguments(p.oid) = 'member_id uuid, actor_user text, chat_id uuid, attachment_id uuid, content_digest text')
            OR (p.proname = 'tf_table_import_result_allowed' AND pg_get_function_identity_arguments(p.oid) = 'member_id uuid, actor_user text, chat_id uuid, result_id uuid')))
        AND NOT ($1 = $3 AND n.nspname = 'app' AND p.proname = 'invitation_delivery'
          AND pg_get_function_identity_arguments(p.oid) = 'workspace uuid, invitation uuid, action text, envelope jsonb, expiry timestamp with time zone'
          AND p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app'))
        AND NOT (n.nspname = 'app' AND p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app')
          AND ((p.proname = 'workspace_access' AND pg_get_function_identity_arguments(p.oid) = 'workspace uuid, exclusive_access boolean')
            OR ($1 = $3 AND p.proname = 'workspace_settings' AND pg_get_function_identity_arguments(p.oid) = 'workspace uuid, actor uuid, membership uuid, command jsonb')))
      LIMIT 1`,
      [
        role,
        names.schema,
        names.runtime,
        names.customOwner,
        onlineCaptureFunctions,
        pgvectorFunctions,
        pgvectorExtension,
      ],
    );
    if (violations.rowCount)
      throw new Error(
        `Workspace principal has ambient privileges outside its capability boundary: ${role} ${violations.rows[0]?.kind} ${violations.rows[0]?.object}`,
      );
  }
  for (const role of [names.runtime, names.migration, names.customOwner]) {
    const confirmationWrites = await client.query("SELECT has_any_column_privilege($1, $2, 'INSERT') AS allowed", [
      role,
      qualified(names.schema, commonTables.confirmations),
    ]);
    if (confirmationWrites.rows[0]?.allowed) throw new Error('Workspace principal can forge confirmation receipts');
  }
  for (const role of [names.runtime, names.confirmation]) {
    for (const [table, columns] of [
      [commonTables.tableCatalog, ['applied_revision', 'applied_definition', 'maintenance']],
      [
        commonTables.migrationJobs,
        ['status', 'plan', 'plan_digest', 'planner_version', 'common_version', 'error_code'],
      ],
      [commonTables.confirmations, ['consumed_at']],
    ] satisfies [string, string[]][]) {
      const writes = await client.query(
        "SELECT 1 FROM unnest($3::text[]) AS column_name WHERE has_column_privilege($1, $2, column_name, 'INSERT,UPDATE') LIMIT 1",
        [role, qualified(names.schema, table), columns],
      );
      if (writes.rowCount) throw new Error('Workspace principal can forge protected migration state');
    }
    const appliedWrites = await client.query(
      "SELECT has_any_column_privilege($1, $2, 'INSERT,UPDATE') OR has_table_privilege($1, $2, 'DELETE,TRUNCATE') AS allowed",
      [role, qualified(names.schema, commonTables.migrationLedger)],
    );
    if (appliedWrites.rows[0]?.allowed) throw new Error('Workspace principal can forge applied receipts');
  }
}

export async function withMaintenanceTransaction<T>(options: {
  connectionString: string;
  workspaceId: string;
  capability: 'migration' | 'confirmation';
  operation: (transaction: { client: SqlClient; schema: string }) => Promise<T>;
}) {
  const names = workspaceNames(options.workspaceId);
  const url = new URL(options.connectionString);
  if (decodeURIComponent(url.username) !== names[options.capability])
    throw new Error('Maintenance credential does not match the workspace capability');
  const client = await withErrorStage('maintenance-connect', () => connectMaintenance(options.connectionString));
  try {
    return await withErrorStage('maintenance-transaction', () =>
      inTransaction(client, async transaction => {
        await withErrorStage('maintenance-identity', async () => {
          const identity = z
            .object({ session_user: z.string(), current_user: z.string() })
            .parse((await transaction.query('SELECT session_user, current_user')).rows[0]);
          if (identity.session_user !== names[options.capability] || identity.current_user !== identity.session_user)
            throw new Error('Maintenance login identity mismatch');
        });
        await withErrorStage('workspace-access', () => fenceWorkspaceAccess(transaction, names.workspaceId));
        if (options.capability === 'migration') {
          await withErrorStage('workspace-migration-lock', () =>
            lockWorkspaceMigration(transaction, names.workspaceId),
          );
          await withErrorStage('maintenance-role', () =>
            transaction.query(`SET LOCAL ROLE ${escapeIdentifier(names.customOwner)}`),
          );
        }
        return options.operation({ client: transaction, schema: names.schema });
      }),
    );
  } finally {
    await client.end();
  }
}
