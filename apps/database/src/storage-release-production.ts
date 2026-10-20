import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { escapeIdentifier, escapeLiteral, type Client } from 'pg';
import { z } from 'zod';
import {
  grantPgvector,
  inTransaction,
  qualified,
  workspaceNames,
  verifyWorkspaceIsolation,
  type Migration,
  type SqlClient,
} from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { azure } from './config.ts';
import { connectionUrl, management } from './azure.ts';
import { optionalSecret, readSecret, saveSecret } from './secrets.ts';
import { connect } from './postgres.ts';
import { readMigrations as readGlobalMigrations } from './migrations.ts';
import { inspectProvisionerAccess, inspectProvisionerWorkspaces } from './storage-release-access.ts';
import {
  releaseLogins,
  releaseLoginListSchema,
  releaseLoginSchema,
  runStorageRelease,
  StorageReleaseError,
  type ReleaseLogin,
  type StorageReleaseCommand,
  type StorageReleasePhase,
} from './storage-release.ts';

const provisionerMarker = 'tulipfarm.storage-release.provisioning.v1';
const productionHost = `${azure.serverName}.postgres.database.azure.com`;
const credentialEnvelope = z.object({
  version: z.literal(1),
  keyId: z.string().min(1),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  ciphertext: z.string().min(1),
  tag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
});

function productionUrl(value: string, database: string, role: string) {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== productionHost ||
    (url.port !== '' && url.port !== '5432') ||
    url.pathname !== `/${database}` ||
    decodeURIComponent(url.username) !== role ||
    !url.password ||
    url.hash ||
    url.search !== '?sslmode=verify-full'
  ) {
    throw new StorageReleaseError('Stored database URL does not match the configured production endpoint and role.');
  }
  return url;
}

export async function checkStorageReleasePrerequisites(
  client: Client,
  migrations: readonly Migration[],
  phase: StorageReleasePhase = 'activation',
) {
  if (phase === 'keys') {
    const storage = await client.query("SELECT to_regclass('app.workspace_storage') AS relation");
    if (!storage.rows[0]?.relation)
      throw new StorageReleaseError(
        'Storage release blocked: required migrations/isolation capability are not installed. No migrations will be executed.',
      );
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query('SET LOCAL row_security = off');
    await client.query("SET LOCAL statement_timeout = '10s'");
    for (const relation of [
      'database_management.migrations',
      'database_management.storage_capabilities',
      'app.workspaces',
      'app.workspace_storage',
      'app.workspace_storage_operations',
    ]) {
      const result = await client.query('SELECT to_regclass($1)::text AS relation', [relation]);
      if (!result.rows[0]?.relation)
        throw new StorageReleaseError(
          'Storage release blocked: required migrations/isolation capability are not installed. Complete targeted cutover first. No migrations will be executed.',
        );
    }
    const receipts = z
      .array(z.object({ name: z.string(), checksum: z.string() }))
      .parse((await client.query('SELECT name, checksum FROM database_management.migrations ORDER BY name')).rows);
    if (
      migrations.length < 1 ||
      receipts.length !== migrations.length ||
      receipts.some(
        (receipt, index) =>
          receipt.name !== migrations[index]?.name || receipt.checksum !== migrations[index]?.checksum,
      )
    ) {
      throw new StorageReleaseError(
        'Storage release blocked: global migration history is incomplete or drifted. No migrations will be executed.',
      );
    }
    if (
      !(await client.query("SELECT 1 FROM database_management.storage_capabilities WHERE capability = 'isolated-v1'"))
        .rowCount
    ) {
      throw new StorageReleaseError(
        'Storage release blocked: installed isolated-v1 capability is required. An environment flag is insufficient.',
      );
    }
    if ((await client.query('SELECT 1 FROM app.workspace_memberships LIMIT 1')).rowCount) {
      throw new StorageReleaseError('Storage release blocked: legacy memberships require the reviewed targeted reset.');
    }
    const identity = z.object({ id: z.uuid(), initial_membership_id: z.uuid(), created_by: z.string() });
    const rows = z
      .array(
        z.discriminatedUnion('tombstone', [
          identity.extend({
            tombstone: z.literal(false),
            ready: z.literal(true),
            credentials: z.literal(true),
            runtime_credential: credentialEnvelope,
            migration_credential: credentialEnvelope,
            confirmation_credential: credentialEnvelope,
          }),
          identity.extend({
            tombstone: z.literal(true),
            runtime_credential: credentialEnvelope.nullable(),
            migration_credential: credentialEnvelope.nullable(),
            confirmation_credential: credentialEnvelope.nullable(),
          }),
        ]),
      )
      .parse(
        (
          await client.query(`SELECT w.id, w.created_by, s.initial_membership_id,
      s.runtime_credential, s.migration_credential, s.confirmation_credential,
      (s.stage = 'unavailable' AND s.disabled_at IS NOT NULL AND s.disabled_operation_id IS NOT NULL) AS tombstone,
      (s.stage = 'ready' AND w.ready_at IS NOT NULL AND w.soul_commit IS NOT NULL AND w.soul_bucket IS NOT NULL
        AND w.soul_key IS NOT NULL AND s.disabled_at IS NULL AND s.disabled_operation_id IS NULL) AS ready,
      (s.runtime_credential IS NOT NULL AND s.migration_credential IS NOT NULL AND s.confirmation_credential IS NOT NULL
        AND s.generation > 0) AS credentials
      FROM app.workspaces w LEFT JOIN app.workspace_storage s ON s.workspace_id=w.id ORDER BY w.id LIMIT 1001`)
        ).rows,
      );
    if (rows.length > 1000) throw new StorageReleaseError('Storage release validation is limited to 1000 workspaces.');
    if (
      (
        await client.query(
          'SELECT 1 FROM app.workspace_storage s LEFT JOIN app.workspaces w ON w.id=s.workspace_id WHERE w.id IS NULL LIMIT 1',
        )
      ).rowCount
    ) {
      throw new StorageReleaseError('Storage release blocked: orphaned storage registry entry.');
    }
    const scopes = await inspectProvisionerWorkspaces(client);
    const expectedSchemas = new Set(rows.map(row => workspaceNames(row.id).schema));
    const installedSchemas = new Set(scopes.map(scope => scope.schema));
    if (
      scopes.some(scope => !expectedSchemas.has(scope.schema)) ||
      rows.some(row => !row.tombstone && !installedSchemas.has(workspaceNames(row.id).schema))
    ) {
      throw new StorageReleaseError('Storage release blocked: workspace registry/schema mismatch.');
    }
    const common = await workspaceTableMigrations();
    for (const row of rows) {
      const names = workspaceNames(row.id);
      if (row.tombstone) {
        if (installedSchemas.has(names.schema)) await verifyWorkspaceIsolation(client, row.id);
        continue;
      }
      const stream = z
        .array(z.object({ name: z.string(), checksum: z.string() }))
        .parse(
          (
            await client.query(
              `SELECT name, checksum FROM ${qualified(names.schema, 'tf_common_migrations')} ORDER BY name LIMIT 1001`,
            )
          ).rows,
        );
      const expected = phase === 'logins' ? common.slice(0, stream.length) : common;
      if (
        stream.length === 0 ||
        JSON.stringify(stream) !== JSON.stringify(expected.map(({ name, checksum }) => ({ name, checksum })))
      ) {
        throw new StorageReleaseError('Storage release blocked: workspace common stream is incomplete or drifted.');
      }
      const state = await client.query(
        `SELECT 1 WHERE
        NOT EXISTS (SELECT 1 FROM ${qualified(names.schema, 'tf_memberships')} WHERE id=$1 AND user_id=$2) OR
        NOT EXISTS (SELECT 1 FROM ${qualified(names.schema, 'tf_soul_head')} WHERE id=1 AND revision ~ '^[a-f0-9]{40}$') OR
        NOT EXISTS (SELECT 1 FROM ${qualified(names.schema, 'tf_authorization_lock')} WHERE id=1)`,
        [row.initial_membership_id, row.created_by],
      );
      if (state.rowCount)
        throw new StorageReleaseError('Storage release blocked: workspace readiness evidence is missing.');
      await verifyWorkspaceIsolation(client, row.id);
    }
    await inspectStorageReleaseLogins(client);
    await client.query('COMMIT');
    return {
      credentialsExist: rows.some(
        row =>
          row.runtime_credential !== null || row.migration_credential !== null || row.confirmation_credential !== null,
      ),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function inspectStorageReleaseLogins(
  client: SqlClient,
  loginList: readonly ReleaseLogin[] = releaseLogins,
) {
  const logins = releaseLoginListSchema.parse(loginList);
  const provisioner = logins[0].role;
  const scopes = await inspectProvisionerWorkspaces(client, provisioner);
  for (const relation of ['common_target', 'common_rollouts']) {
    const result = await client.query(
      'SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = to_regclass($1)',
      [`database_management.${relation}`],
    );
    if (result.rows.length && result.rows[0]?.owner !== provisioner) {
      throw new StorageReleaseError('Existing rollout tables need an explicit ownership preservation plan.');
    }
  }
  for (const login of logins) {
    const existing = (
      await client.query(
        `SELECT shobj_description(oid, 'pg_authid') AS marker,
      rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
      FROM pg_roles WHERE rolname = $1`,
        [login.role],
      )
    ).rows[0];
    if (!existing) continue;
    const row = z
      .object({
        marker: z.string().nullable(),
        rolsuper: z.boolean(),
        rolcreatedb: z.boolean(),
        rolcreaterole: z.boolean(),
        rolreplication: z.boolean(),
        rolbypassrls: z.boolean(),
        rolinherit: z.boolean(),
      })
      .parse(existing);
    const marker =
      login.capability === 'provisioning' ? provisionerMarker : `tulipfarm.table-registry.${login.capability}`;
    if (
      row.marker !== marker ||
      row.rolsuper ||
      row.rolcreatedb ||
      row.rolreplication ||
      row.rolbypassrls ||
      row.rolinherit ||
      row.rolcreaterole !== (login.capability === 'provisioning')
    )
      throw new StorageReleaseError('Unexpected or elevated storage release role. Reconcile before applying.');
    if (login.capability === 'provisioning') {
      await inspectProvisionerAccess(client, scopes, provisioner);
    } else if (
      (await client.query('SELECT 1 FROM pg_auth_members WHERE member = $1::regrole', [login.role])).rowCount
    ) {
      throw new StorageReleaseError('Storage release login has unexpected role membership.');
    }
  }
}

export async function configureStorageReleaseLogin(
  client: SqlClient,
  input: ReleaseLogin,
  password: string,
  loginList: readonly ReleaseLogin[] = releaseLogins,
) {
  const logins = releaseLoginListSchema.parse(loginList);
  const login = releaseLoginSchema.parse(input);
  if (
    !logins.some(
      candidate =>
        candidate.capability === login.capability && candidate.role === login.role && candidate.secret === login.secret,
    )
  ) {
    throw new StorageReleaseError('Configured login must belong to the validated release login list.');
  }
  await inspectStorageReleaseLogins(client, logins);
  if (login.capability !== 'provisioning') {
    await provisionTableRegistry(client, { capability: login.capability, role: login.role, password });
    return;
  }
  z.string().min(24).parse(password);
  await inTransaction(client, async transaction => {
    await inspectStorageReleaseLogins(transaction, logins);
    const role = escapeIdentifier(login.role);
    const database = z
      .object({ name: z.string() })
      .parse((await transaction.query('SELECT current_database() AS name')).rows[0]).name;
    if (!(await transaction.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login.role])).rowCount) {
      await transaction.query(
        `CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await transaction.query(`COMMENT ON ROLE ${role} IS ${escapeLiteral(provisionerMarker)}`);
    }
    await transaction.query(`ALTER ROLE ${role} LOGIN PASSWORD ${escapeLiteral(password)}`);
    await transaction.query(`ALTER ROLE ${role} SET search_path TO pg_catalog`);
    await transaction.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${role} WITH GRANT OPTION`);
    await transaction.query(`GRANT CREATE ON DATABASE ${escapeIdentifier(database)} TO ${role}`);
    await transaction.query(`GRANT USAGE ON SCHEMA app TO ${role} WITH GRANT OPTION`);
    await grantPgvector(transaction, login.role, true);
    await transaction.query(
      `GRANT EXECUTE ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) TO ${role} WITH GRANT OPTION`,
    );
    if (
      (await transaction.query("SELECT to_regprocedure('app.workspace_access(uuid,boolean)') AS routine")).rows[0]
        ?.routine
    ) {
      await transaction.query(
        `GRANT EXECUTE ON FUNCTION app.workspace_access(uuid, boolean), app.workspace_settings(uuid, uuid, uuid, jsonb), app.model_availability_receipt() TO ${role} WITH GRANT OPTION`,
      );
    }
    await transaction.query(`GRANT SELECT ON app.workspaces TO ${role}`);
    await transaction.query(`GRANT UPDATE (soul_commit, soul_bucket, soul_key, ready_at) ON app.workspaces TO ${role}`);
    await transaction.query(`GRANT SELECT, UPDATE ON app.workspace_storage TO ${role}`);
    await transaction.query(`GRANT SELECT, INSERT ON app.workspace_storage_operations TO ${role}`);
    await transaction.query(`GRANT USAGE, CREATE ON SCHEMA database_management TO ${role}`);
    await inspectStorageReleaseLogins(transaction, logins);
  });
}

export async function executeProductionStorageRelease(command: StorageReleaseCommand) {
  let connection: Client | undefined;
  const database = async () => {
    if (connection) return connection;
    const adminUrl = productionUrl(await readSecret('database-admin-url'), 'postgres', azure.administrator);
    adminUrl.pathname = '/tulipfarm';
    connection = await connect(adminUrl.href);
    await connection.query('SELECT pg_advisory_lock(734128, 2)');
    return connection;
  };
  try {
    const migrations = await readGlobalMigrations(fileURLToPath(new URL('../migrations/', import.meta.url)));
    return await runStorageRelease(command, {
      async prerequisites(phase) {
        const client = await database();
        return checkStorageReleasePrerequisites(client, migrations, phase);
      },
      readSecret: optionalSecret,
      async saveSecret(name, value) {
        const current = await optionalSecret(name);
        if (current !== undefined && current !== value)
          throw new StorageReleaseError('Secret changed during planning. Refusing to overwrite it.');
        await saveSecret(name, value);
      },
      randomHex: () => randomBytes(32).toString('hex'),
      loginUrl: (login, password) => connectionUrl(productionHost, 'tulipfarm', login.role, password),
      loginPassword: (login, value) => {
        const url = productionUrl(value, 'tulipfarm', login.role);
        return z.string().min(24).parse(decodeURIComponent(url.password));
      },
      inspectLogins: async () => inspectStorageReleaseLogins(await database()),
      configureLogin: async (login, password) => configureStorageReleaseLogin(await database(), login, password),
      async verifyLogin(login, url) {
        const scoped = await connect(url);
        try {
          const identity = await scoped.query('SELECT current_user, session_user');
          if (identity.rows[0]?.current_user !== login.role || identity.rows[0]?.session_user !== login.role)
            throw new StorageReleaseError('Scoped login verification failed.');
        } finally {
          await scoped.end();
        }
      },
      async retention() {
        const server = await management.servers.get(azure.resourceGroup, azure.serverName);
        if (server.state !== 'Ready') throw new StorageReleaseError('Azure PostgreSQL server must be Ready.');
        return z.number().int().min(7).max(35).parse(server.backup?.backupRetentionDays);
      },
      async setRetention(retentionDays) {
        await management.servers.beginUpdateAndWait(azure.resourceGroup, azure.serverName, {
          backup: { backupRetentionDays: retentionDays },
        });
      },
    });
  } finally {
    await connection?.end();
  }
}
