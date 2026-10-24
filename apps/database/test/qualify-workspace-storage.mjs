import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client, Pool, escapeIdentifier as ident, escapeLiteral as literal } from 'pg';
import {
  provisionWorkspace,
  qualified,
  tableTableName,
  verifyWorkspaceIsolation,
  withMaintenanceTransaction,
  workspaceNames,
} from '../../../packages/workspace-storage/src/provisioning.ts';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { provisionTableRegistry } from '../../../packages/workspaces/src/table-registry.ts';
import {
  credentialKeyring,
  decryptCredential,
  encryptCredential,
} from '../../../packages/workspaces/src/credentials.ts';
import { rotateWorkspaceCredentials, WorkspaceOperatorConflict } from '../../../packages/workspaces/src/operators.ts';

const target = process.argv[2];
if (
  !['local', 'azure'].includes(target) ||
  process.argv[3] !== '--create-disposable-database' ||
  process.argv.length !== 4
) {
  process.stderr.write(
    'Usage: node apps/database/test/qualify-workspace-storage.mjs local|azure --create-disposable-database\n',
  );
  process.exit(2);
}

const token = randomBytes(12).toString('hex');
const database = `storage_qual_${token}`;
const provisioner = `${database}_provisioner`;
const registries = ['authoring', 'confirmation', 'migration'].map(capability => ({
  capability,
  role: `${database}_${capability}`,
  password: randomBytes(32).toString('hex'),
}));
const workspaces = ['a', 'b'].map(label => {
  const id = randomUUID();
  return {
    label,
    id,
    names: workspaceNames(id),
    userId: randomUUID(),
    membershipId: randomUUID(),
    passwords: Object.fromEntries(
      ['runtime', 'migration', 'confirmation'].map(key => [key, randomBytes(32).toString('hex')]),
    ),
  };
});
const roleNames = [
  ...registries.map(({ role }) => role),
  ...workspaces.flatMap(({ names }) => [names.runtime, names.migration, names.confirmation, names.customOwner]),
];
const registryOids = new Map();
const clients = new Set();
const results = [];
const events = [];
const ownedRoles = new Set();
let databaseOid;
let provisionerOid;
let admin;
let stage = 'configuration';
let interrupted = false;
let cleaning = false;
let administrator;
const emit = event => {
  const entry = { timestamp: new Date().toISOString(), target, ...event };
  events.push(entry);
  if (event.event !== 'check' || event.status !== 'PASS') process.stdout.write(`${JSON.stringify(entry)}\n`);
};
const codeOf = error =>
  typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNCLASSIFIED';
const record = (name, status, code) => {
  results.push({ name, status, ...(code ? { code } : {}) });
  emit({ event: 'check', ...results.at(-1) });
};
const interrupt = () => {
  interrupted = true;
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function connect(connectionString) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 15000,
    statement_timeout: 20000,
    lock_timeout: 5000,
    application_name: database,
  });
  client.on('error', error => record('connection interrupted', 'FAIL', codeOf(error)));
  clients.add(client);
  try {
    await client.connect();
  } catch (error) {
    await client.end();
    clients.delete(client);
    throw error;
  }
  return client;
}

async function rejectPassword(connectionString) {
  await assert.rejects(
    async () => {
      const client = await connect(connectionString);
      await client.end();
      clients.delete(client);
    },
    error => error.code === '28P01',
  );
}

async function directIdentity(client, role) {
  assert.deepEqual((await client.query('SELECT session_user, current_user, current_database() AS database')).rows, [
    { session_user: role, current_user: role, database },
  ]);
  assert.deepEqual(
    (
      await client.query(
        'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = current_user',
      )
    ).rows,
    [
      {
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: false,
      },
    ],
  );
}

async function check(name, operation) {
  if (interrupted && !cleaning) throw Object.assign(new Error(), { code: 'INTERRUPTED' });
  try {
    await operation();
    record(name, 'PASS');
  } catch (error) {
    record(name, 'FAIL', codeOf(error));
  }
}

async function deny(client, name, sql, values = []) {
  await check(name, async () => {
    await client.query('BEGIN');
    try {
      try {
        await client.query(sql, values);
      } catch (error) {
        if (error.code === '42501') return;
        throw error;
      }
      throw Object.assign(new Error(), { code: 'EXPECTED_DENIAL' });
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

async function cleanup() {
  cleaning = true;
  for (const client of clients) {
    if (client !== admin) {
      try {
        await client.end();
      } catch (error) {
        record('close qualification connection', 'FAIL', codeOf(error));
      }
    }
  }
  if (!admin) return;
  if (databaseOid) {
    await check(`cleanup database ${database}`, async () => {
      const existing = await admin.query(
        'SELECT oid, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
        [database],
      );
      assert.equal(existing.rows[0]?.oid, databaseOid);
      assert.equal(existing.rows[0]?.owner, provisioner);
      await admin.query(`DROP DATABASE ${ident(database)}`);
      assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount, 0);
    });
  }
  if (provisionerOid) {
    for (const { role, capability } of registries) {
      await check(`cleanup registry role ${role}`, async () => {
        const existing = await admin.query(
          "SELECT oid, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1",
          [role],
        );
        if (!existing.rowCount) return;
        assert.equal(existing.rows[0].oid, registryOids.get(role));
        assert.equal(existing.rows[0].marker, `tulipfarm.table-registry.${capability}`);
        await admin.query(`SET ROLE ${ident(provisioner)}`);
        try {
          await admin.query(`DROP ROLE ${ident(role)}`);
        } finally {
          await admin.query('RESET ROLE');
        }
        assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount, 0);
      });
    }
    for (const workspace of workspaces) {
      for (const name of [
        workspace.names.runtime,
        workspace.names.migration,
        workspace.names.confirmation,
        workspace.names.customOwner,
      ]) {
        await check(`cleanup role ${name}`, async () => {
          const existing = await admin.query(
            "SELECT oid, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1",
            [name],
          );
          if (!existing.rowCount) return;
          assert.equal(existing.rows[0].marker, `tulipfarm.workspace.${workspace.id}`);
          assert.ok(ownedRoles.has(name));
          await admin.query(`SET ROLE ${ident(provisioner)}`);
          try {
            await admin.query(`DROP ROLE ${ident(name)}`);
          } finally {
            await admin.query('RESET ROLE');
          }
          assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount, 0);
        });
      }
    }
    await check(`cleanup role ${provisioner}`, async () => {
      const existing = await admin.query('SELECT oid FROM pg_roles WHERE rolname = $1', [provisioner]);
      assert.equal(existing.rows[0]?.oid, provisionerOid);
      await admin.query(`DROP ROLE ${ident(provisioner)}`);
      assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [provisioner])).rowCount, 0);
    });
  }
  try {
    const remaining = await admin.query(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
      [[provisioner, ...roleNames]],
    );
    const databases = await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [database]);
    emit({
      event: 'cleanup',
      database,
      roles: [provisioner, ...roleNames],
      remainingRoles: remaining.rows.map(row => row.rolname),
      remainingDatabases: databases.rows.map(row => row.datname),
    });
    if (remaining.rowCount || databases.rowCount) record('all qualification objects removed', 'FAIL', 'OBJECTS_REMAIN');
    else record('all qualification objects removed', 'PASS');
  } catch (error) {
    record('verify cleanup', 'FAIL', codeOf(error));
  }
  await admin.end();
}

try {
  const sources = [
    'apps/database/test/qualify-workspace-storage.mjs',
    'apps/worker/src/storage-worker.ts',
    ...['provisioning', 'migrations', 'names', 'transactions'].map(name => `packages/workspace-storage/src/${name}.ts`),
    ...['provisioning', 'migrations', 'names', 'transactions', 'runtime'].map(
      name => `packages/workspace-storage/dist/${name}.js`,
    ),
    'packages/workspace-storage/common/0001_baseline.sql',
    'packages/workspace-storage/common/0003_chat_send_timing.sql',
    'packages/workspace-storage/common/0004_social.sql',
    'packages/workspace-storage/common/0005_knowledge_github_item_path.sql',
    'packages/workspace-storage/common/0006_github_knowledge_opt_out.sql',
    'packages/workspace-storage/common/0007_knowledge_github_commits.sql',
    'packages/workspace-storage/common/0008_knowledge_freshness.sql',
    'packages/workspace-storage/common/0009_github_app_refresh.sql',
    'packages/workspace-storage/common/0010_github_knowledge_commits_backfill.sql',
    'packages/workspace-storage/common/0011_knowledge_media.sql',
    'packages/workspace-storage/common/0012_image_settings.sql',
    'packages/workspace-storage/common/0013_turn_image_models.sql',
    'packages/workspace-storage/common/0014_conversation_links.sql',
    ...['table-migrations', 'table-registry', 'credentials', 'operators'].map(
      name => `packages/workspaces/src/${name}.ts`,
    ),
  ].map(path => ({
    path,
    sha256: createHash('sha256')
      .update(readFileSync(new URL(`../../../${path}`, import.meta.url)))
      .digest('hex'),
  }));
  emit({ event: 'sources', sources });
  const migrations = await workspaceTableMigrations();
  assert.deepEqual(
    migrations.map(({ name }) => name),
    [
      '0001_baseline.sql',
      '0002_turn_trace.sql',
      '0003_chat_send_timing.sql',
      '0004_social.sql',
      '0005_knowledge_github_item_path.sql',
      '0006_github_knowledge_opt_out.sql',
      '0007_knowledge_github_commits.sql',
      '0008_knowledge_freshness.sql',
      '0009_github_app_refresh.sql',
      '0010_github_knowledge_commits_backfill.sql',
      '0011_knowledge_media.sql',
      '0012_image_settings.sql',
      '0013_turn_image_models.sql',
      '0014_conversation_links.sql',
    ],
  );
  emit({
    event: 'common-stream',
    version: migrations.length,
    migrations: migrations.map(({ name, checksum }) => ({ name, checksum })),
  });
  const url = new URL(process.env.DATABASE_ADMIN_URL);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.pathname, '/postgres');
  if (target === 'local') {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.search, '');
  } else {
    assert.equal(url.hostname, 'tulipfarm-cloud.postgres.database.azure.com');
    assert.equal(url.search, '?sslmode=verify-full');
    assert.equal(decodeURIComponent(url.username), 'tfadmin');
  }
  emit({
    event: 'objects',
    database,
    provisioner,
    registries: registries.map(({ role, capability }) => ({ role, capability })),
    workspaces: workspaces.map(({ label, id, names }) => ({ label, id, names })),
  });
  stage = 'connect documented admin';
  admin = await connect(url.href);
  const server = (
    await admin.query(
      "SELECT version() AS version, current_setting('server_version_num')::integer AS version_num, current_user, current_database() AS database",
    )
  ).rows[0];
  administrator = server.current_user;
  emit({ event: 'server', ...server });
  assert.ok(server.version_num >= 180000 && server.version_num < 190000);
  assert.equal(server.database, 'postgres');
  record('PostgreSQL 18 admin connection', 'PASS');
  stage = 'check disposable names absent';
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount, 0);
  assert.equal(
    (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = ANY($1::text[])', [[provisioner, ...roleNames]]))
      .rowCount,
    0,
  );
  const password = randomBytes(32).toString('hex');
  stage = 'CREATE ROLE scoped non-superuser provisioner';
  await admin.query(
    `CREATE ROLE ${ident(provisioner)} LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${literal(password)}`,
  );
  provisionerOid = (await admin.query('SELECT oid FROM pg_roles WHERE rolname = $1', [provisioner])).rows[0].oid;
  record(stage, 'PASS');
  stage = 'GRANT scoped provisioner SET membership to admin';
  await admin.query(`GRANT ${ident(provisioner)} TO ${ident(administrator)} WITH INHERIT FALSE, SET TRUE`);
  record(stage, 'PASS');
  stage = 'CREATE DATABASE owned by scoped provisioner';
  await admin.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(provisioner)}`);
  await provisionTestPgvector(admin, database, provisioner);
  databaseOid = (await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [database])).rows[0].oid;
  record(stage, 'PASS');
  url.pathname = `/${database}`;
  const databaseAdmin = await connect(url.href);
  stage = 'revoke PUBLIC in disposable database';
  await databaseAdmin.query(`REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC`);
  await databaseAdmin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  url.username = provisioner;
  url.password = password;
  const connectionString = url.href;
  const platform = await connect(connectionString);
  const platformRole = (
    await platform.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    )
  ).rows[0];
  assert.deepEqual(platformRole, {
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: true,
    rolreplication: false,
    rolbypassrls: false,
  });
  record('direct scoped non-superuser provisioner login', 'PASS');
  await platform.query(
    "CREATE SCHEMA app; REVOKE ALL ON SCHEMA app FROM PUBLIC; CREATE TABLE app.accounts (id integer PRIMARY KEY, secret text); INSERT INTO app.accounts VALUES (1, 'platform-only')",
  );
  await platform.query(
    "CREATE FUNCTION app.invitation_delivery(workspace uuid, invitation uuid, action text, envelope jsonb DEFAULT NULL, expiry timestamptz DEFAULT NULL) RETURNS void LANGUAGE sql AS 'SELECT'; REVOKE ALL ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) FROM PUBLIC",
  );
  await platform.query(`CREATE TABLE app.workspace_storage (workspace_id uuid PRIMARY KEY, generation integer, stage text,
    runtime_credential jsonb, migration_credential jsonb, confirmation_credential jsonb, updated_at timestamptz);
    CREATE TABLE app.workspaces (id uuid PRIMARY KEY, created_by text, created_at timestamptz DEFAULT now(),
      soul_commit text, soul_bucket text, soul_key text, name text);
    CREATE TABLE app.workspace_storage_operations (workspace_id uuid, operation_id uuid, kind text, operator text,
      expected_generation integer, generation integer, key_ids jsonb, PRIMARY KEY (workspace_id, operation_id))`);
  for (const workspace of workspaces) {
    stage = `provision workspace ${workspace.label}`;
    for (const key of ['runtime', 'migration', 'confirmation', 'customOwner']) ownedRoles.add(workspace.names[key]);
    await provisionWorkspace({
      connectionString,
      workspaceId: workspace.id,
      passwords: workspace.passwords,
      migrations,
      initialAdmin: { userId: workspace.userId, membershipId: workspace.membershipId },
    });
    record(stage, 'PASS');
  }
  stage = 'direct login probes';
  const login = (workspace, capability) => {
    const credential = new URL(connectionString);
    credential.username = workspace.names[capability];
    credential.password = workspace.passwords[capability];
    return credential.href;
  };
  for (const workspace of workspaces) {
    workspace.clients = {};
    for (const capability of ['runtime', 'migration', 'confirmation']) {
      const client = await connect(login(workspace, capability));
      workspace.clients[capability] = client;
      await check(`${workspace.label} ${capability} direct restricted login`, async () => {
        await directIdentity(client, workspace.names[capability]);
        assert.deepEqual(
          (
            await client.query(
              `SELECT name, checksum FROM ${qualified(workspace.names.schema, 'tf_common_migrations')} ORDER BY name`,
            )
          ).rows,
          migrations.map(({ name, checksum }) => ({ name, checksum })),
        );
      });
    }
    await withMaintenanceTransaction({
      connectionString: login(workspace, 'migration'),
      workspaceId: workspace.id,
      capability: 'migration',
      operation: async ({ client, schema }) => {
        await client.query(
          `CREATE TABLE ${qualified(schema, 'invoices')} (id bigserial PRIMARY KEY, value text NOT NULL)`,
        );
      },
    });
  }
  for (const [workspace, other] of [
    [workspaces[0], workspaces[1]],
    [workspaces[1], workspaces[0]],
  ]) {
    const { runtime, migration, confirmation } = workspace.clients;
    const at = table => qualified(workspace.names.schema, table);
    const bt = table => qualified(other.names.schema, table);
    const prefix = workspace.label;
    await check(`${prefix} runtime own CRUD and sequence`, async () => {
      await runtime.query(`INSERT INTO ${at('invoices')} (value) VALUES ('own')`);
      assert.deepEqual((await runtime.query(`SELECT id::integer, value FROM ${at('invoices')}`)).rows, [
        { id: 1, value: 'own' },
      ]);
      await runtime.query(`UPDATE ${at('invoices')} SET value = 'updated' WHERE id = 1`);
      assert.equal((await runtime.query(`SELECT value FROM ${at('invoices')}`)).rows[0].value, 'updated');
      assert.equal((await runtime.query(`DELETE FROM ${at('invoices')} WHERE id = 1`)).rowCount, 1);
    });
    for (const [capability, client] of Object.entries(workspace.clients)) {
      for (const [name, sql] of [
        ['other common read', `SELECT * FROM ${bt('tf_memberships')}`],
        ['other custom read', `SELECT * FROM ${bt('invoices')}`],
        ['other custom write', `INSERT INTO ${bt('invoices')} (value) VALUES ('attack')`],
        ['other sequence', `SELECT nextval(${literal(bt('invoices_id_seq'))})`],
        ['platform read', 'SELECT * FROM app.accounts'],
        ['platform write', "UPDATE app.accounts SET secret = 'attack'"],
        ['other owner SET ROLE', `SET ROLE ${ident(other.names.customOwner)}`],
        ['provisioner SET ROLE', `SET ROLE ${ident(provisioner)}`],
        ['common ALTER', `ALTER TABLE ${at('tf_memberships')} ADD COLUMN attack text`],
        ['schema DROP', `DROP SCHEMA ${ident(workspace.names.schema)} CASCADE`],
        ['temporary CREATE', 'CREATE TEMP TABLE attack (id integer)'],
        ['public CREATE', 'CREATE TABLE public.attack (id integer)'],
      ])
        await deny(client, `${prefix} ${capability} denies ${name}`, sql);
    }
    for (const [name, sql] of [
      ['own owner SET ROLE', `SET ROLE ${ident(workspace.names.customOwner)}`],
      ['migration SET ROLE', `SET ROLE ${ident(workspace.names.migration)}`],
      ['confirmation SET ROLE', `SET ROLE ${ident(workspace.names.confirmation)}`],
      ['session authorization', `SET SESSION AUTHORIZATION ${ident(provisioner)}`],
      ['own CREATE', `CREATE TABLE ${at('attack')} (id integer)`],
      ['confirmation forgery', `INSERT INTO ${at('tf_confirmations')} DEFAULT VALUES`],
      ['ledger forgery', `INSERT INTO ${at('tf_migration_ledger')} DEFAULT VALUES`],
      ['applied revision forgery', `UPDATE ${at('tf_table_catalog')} SET applied_revision = 'forged'`],
      ['applied job forgery', `UPDATE ${at('tf_migration_jobs')} SET status = 'applied'`],
      ['role self-grant', `GRANT ${ident(workspace.names.customOwner)} TO ${ident(workspace.names.runtime)}`],
    ])
      await deny(runtime, `${prefix} runtime denies ${name}`, sql);
    await deny(
      migration,
      `${prefix} migration requires explicit owner SET ROLE`,
      `CREATE TABLE ${at('attack')} (id integer)`,
    );
    await migration.query(`SET ROLE ${ident(workspace.names.customOwner)}`);
    await check(`${prefix} migration own custom ALTER and future table`, async () => {
      await migration.query(`ALTER TABLE ${at('invoices')} ADD COLUMN note text`);
      await migration.query(`CREATE TABLE ${at('future_invoices')} (id bigserial PRIMARY KEY, value text)`);
      await runtime.query(`INSERT INTO ${at('future_invoices')} (value) VALUES ('future')`);
      assert.deepEqual((await runtime.query(`SELECT id::integer, value FROM ${at('future_invoices')}`)).rows, [
        { id: 1, value: 'future' },
      ]);
    });
    for (const [name, sql] of [
      ['other ALTER', `ALTER TABLE ${bt('invoices')} ADD COLUMN attack text`],
      ['other read', `SELECT * FROM ${bt('invoices')}`],
      ['other sequence', `SELECT nextval(${literal(bt('invoices_id_seq'))})`],
      ['platform read', 'SELECT * FROM app.accounts'],
      ['common ALTER', `ALTER TABLE ${at('tf_memberships')} ADD COLUMN attack text`],
      ['schema DROP', `DROP SCHEMA ${ident(workspace.names.schema)} CASCADE`],
      ['policy write', `UPDATE ${at('tf_memberships')} SET role = 'admin'`],
      ['confirmation forgery', `INSERT INTO ${at('tf_confirmations')} DEFAULT VALUES`],
      ['common dependency', `CREATE TABLE ${at('dependency')} (id uuid REFERENCES ${at('tf_memberships')} (id))`],
      ['platform dependency', `CREATE TABLE ${at('identity_dependency')} (id integer REFERENCES app.accounts (id))`],
      ['common inheritance', `CREATE TABLE ${at('inherited_attack')} () INHERITS (${at('tf_memberships')})`],
    ])
      await deny(migration, `${prefix} custom owner denies ${name}`, sql);
    await check(`${prefix} custom view DROP preserves common table`, async () => {
      await migration.query(`CREATE VIEW ${at('custom_view')} AS SELECT id FROM ${at('tf_memberships')}`);
      await migration.query(`DROP VIEW ${at('custom_view')} CASCADE`);
      assert.equal((await runtime.query(`SELECT * FROM ${at('tf_memberships')}`)).rowCount, 1);
    });
    await migration.query(`CREATE FUNCTION ${at('custom_function')}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    await deny(runtime, `${prefix} runtime denies future function execution`, `SELECT ${at('custom_function')}()`);
    for (const [name, sql] of [
      ['ledger forgery', `INSERT INTO ${at('tf_migration_ledger')} DEFAULT VALUES`],
      ['receipt consumption', `UPDATE ${at('tf_confirmations')} SET consumed_at = now()`],
      ['custom CREATE', `CREATE TABLE ${at('attack')} (id integer)`],
      ['owner SET ROLE', `SET ROLE ${ident(workspace.names.customOwner)}`],
    ])
      await deny(confirmation, `${prefix} confirmation denies ${name}`, sql);
    await check(`${prefix} confirmation receipt and migration activation transaction`, async () => {
      const team = randomUUID(),
        resource = randomUUID(),
        command = randomUUID(),
        job = randomUUID(),
        receipt = randomUUID();
      await runtime.query(`INSERT INTO ${at('tf_teams')} (id, name) VALUES ($1, 'Finance')`, [team]);
      await runtime.query(
        `INSERT INTO ${at('tf_table_catalog')} (id, owning_team_id, physical_table, display_name, target_revision) VALUES ($1, $2, 'invoices', 'Invoices', 'revision-1')`,
        [resource, team],
      );
      await runtime.query(
        `INSERT INTO ${at('tf_authoring_commands')} (id, membership_id, table_id, request_id, change, status) VALUES ($1, $2, $3, 'request-1', '{}', 'accepted')`,
        [command, workspace.membershipId, resource],
      );
      await runtime.query(
        `INSERT INTO ${at('tf_migration_jobs')} (id, table_id, command_id, membership_id, target_revision) VALUES ($1, $2, $3, $4, 'revision-1')`,
        [job, resource, command, workspace.membershipId],
      );
      await withMaintenanceTransaction({
        connectionString: login(workspace, 'confirmation'),
        workspaceId: workspace.id,
        capability: 'confirmation',
        operation: async ({ client }) => {
          await client.query(`SELECT id FROM ${at('tf_authorization_lock')} WHERE id = 1 FOR SHARE`);
          await client.query(
            `INSERT INTO ${at('tf_confirmations')} (id, workspace_id, table_id, migration_id, plan_digest, destructive_effect, membership_id, expires_at) VALUES ($1, $2, $3, $4, 'digest', '{"drop":"note"}', $5, now() + interval '24 hours')`,
            [receipt, workspace.id, resource, job, workspace.membershipId],
          );
        },
      });
      await withMaintenanceTransaction({
        connectionString: login(workspace, 'migration'),
        workspaceId: workspace.id,
        capability: 'migration',
        operation: async ({ client }) => {
          await client.query(`SELECT id FROM ${at('tf_authorization_lock')} WHERE id = 1 FOR SHARE`);
          await client.query(`SELECT id FROM ${at('tf_table_catalog')} WHERE id = $1 FOR UPDATE`, [resource]);
          await client.query(`ALTER TABLE ${at('invoices')} DROP COLUMN note`);
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
      assert.deepEqual(
        (await runtime.query(`SELECT applied_revision, confirmation_id FROM ${at('tf_migration_ledger')}`)).rows,
        [{ applied_revision: 'revision-1', confirmation_id: receipt }],
      );
      assert.equal(
        (await runtime.query(`SELECT consumed_at IS NOT NULL AS consumed FROM ${at('tf_confirmations')}`)).rows[0]
          .consumed,
        true,
      );
    });
    await platform.query(`CREATE TABLE ${at('tf_future_common')} (id bigserial PRIMARY KEY)`);
    await deny(runtime, `${prefix} future common table has no ambient read`, `SELECT * FROM ${at('tf_future_common')}`);
    await deny(
      runtime,
      `${prefix} future common sequence has no ambient usage`,
      `SELECT nextval(${literal(at('tf_future_common_id_seq'))})`,
    );
    await check(`${prefix} common ownership and isolation verifier`, async () => {
      await verifyWorkspaceIsolation(platform, workspace.id);
      const owners = await platform.query(
        "SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname LIKE 'tf_%'",
        [workspace.names.schema],
      );
      assert.deepEqual(owners.rows, [{ owner: provisioner }]);
    });
    await check(`${prefix} idempotent provisioning`, async () => {
      await provisionWorkspace({
        connectionString,
        workspaceId: workspace.id,
        passwords: workspace.passwords,
        migrations,
        initialAdmin: { userId: workspace.userId, membershipId: randomUUID() },
      });
      assert.deepEqual((await runtime.query(`SELECT id FROM ${at('tf_memberships')}`)).rows, [
        { id: workspace.membershipId },
      ]);
      assert.deepEqual(
        (await runtime.query(`SELECT name, checksum FROM ${at('tf_common_migrations')} ORDER BY name`)).rows,
        migrations.map(({ name, checksum }) => ({ name, checksum })),
      );
    });
  }
  for (const [workspace, other] of [
    [workspaces[0], workspaces[1]],
    [workspaces[1], workspaces[0]],
  ]) {
    for (const [capability, client] of Object.entries(workspace.clients)) {
      await deny(
        client,
        `${workspace.label} ${capability} denies other future table`,
        `SELECT * FROM ${qualified(other.names.schema, 'future_invoices')}`,
      );
      await deny(
        client,
        `${workspace.label} ${capability} denies other future sequence`,
        `SELECT nextval(${literal(qualified(other.names.schema, 'future_invoices_id_seq'))})`,
      );
    }
  }
  await check('hostile identifiers rejected before SQL', async () => {
    for (const name of ['x; DROP SCHEMA app CASCADE', 'tf_memberships', 'pg_class', 'a'.repeat(64), '"invoices"'])
      assert.throws(() => tableTableName(name));
    assert.throws(() => workspaceNames('x; DROP SCHEMA app CASCADE'));
    assert.deepEqual((await platform.query('SELECT * FROM app.accounts')).rows, [{ id: 1, secret: 'platform-only' }]);
  });
  stage = 'current-stream domain grants';
  for (const workspace of workspaces) {
    const at = table => qualified(workspace.names.schema, table);
    const { runtime, migration, confirmation } = workspace.clients;
    await migration.query('RESET ROLE');
    await check(`${workspace.label} current-stream runtime domain writes`, async () => {
      const invitation = randomUUID(),
        retired = randomUUID(),
        agent = randomUUID();
      await runtime.query(
        `INSERT INTO ${at('tf_invitations')} (id, issuer_membership_id, kind, email, token_hash)
        VALUES ($1, $2, 'email', 'qualification@example.com', $3)`,
        [invitation, workspace.membershipId, randomBytes(32).toString('hex')],
      );
      await runtime.query(`INSERT INTO ${at('tf_retired_teams')} (id) VALUES ($1)`, [retired]);
      await runtime.query(`INSERT INTO ${at('tf_agents')} (id) VALUES ($1)`, [agent]);
      assert.deepEqual((await runtime.query(`SELECT id FROM ${at('tf_invitations')}`)).rows, [{ id: invitation }]);
      assert.deepEqual((await runtime.query(`SELECT id FROM ${at('tf_retired_teams')}`)).rows, [{ id: retired }]);
      assert.deepEqual((await runtime.query(`SELECT id FROM ${at('tf_agents')}`)).rows, [{ id: agent }]);
    });
    for (const [capability, client] of [
      ['migration', migration],
      ['confirmation', confirmation],
    ]) {
      await check(`${workspace.label} ${capability} agent authorization read`, async () => {
        assert.equal((await client.query(`SELECT id FROM ${at('tf_agents')}`)).rowCount, 1);
      });
      for (const table of [
        'tf_invitations',
        'tf_invitation_redemptions',
        'tf_retired_teams',
        'tf_agent_definitions',
        'tf_agent_tool_calls',
      ]) {
        await deny(
          client,
          `${workspace.label} ${capability} denies private domain ${table}`,
          `SELECT * FROM ${at(table)}`,
        );
      }
      await deny(
        client,
        `${workspace.label} ${capability} denies agent enablement`,
        `UPDATE ${at('tf_agents')} SET enabled = false`,
      );
    }
    for (const [name, sql] of [
      ['control completion', `UPDATE ${at('tf_table_controls')} SET processed_at = now()`],
      ['execution event forgery', `INSERT INTO ${at('tf_table_execution_events')} DEFAULT VALUES`],
      ['retired-team deletion', `DELETE FROM ${at('tf_retired_teams')}`],
      ['agent definition rewrite', `UPDATE ${at('tf_agent_definitions')} SET definition = '{}'`],
    ])
      await deny(runtime, `${workspace.label} runtime denies ${name}`, sql);
  }

  stage = 'seed disposable encrypted registry';
  for (const capability of ['runtime', 'migration', 'confirmation']) {
    const prefix = `WORKSPACE_${capability.toUpperCase()}_KEY`;
    process.env[prefix] = randomBytes(32).toString('hex');
    process.env[`${prefix}_ID`] = 'qualification-v1';
    delete process.env[`WORKSPACE_${capability.toUpperCase()}_PREVIOUS_KEYS`];
  }
  for (const workspace of workspaces) {
    const envelopes = ['runtime', 'migration', 'confirmation'].map(capability =>
      encryptCredential(
        login(workspace, capability),
        { workspaceId: workspace.id, generation: 1, capability },
        credentialKeyring(capability),
      ),
    );
    await platform.query(
      `INSERT INTO app.workspace_storage (workspace_id, generation, stage, runtime_credential, migration_credential, confirmation_credential)
      VALUES ($1, 1, 'ready', $2, $3, $4)`,
      [workspace.id, ...envelopes],
    );
    await platform.query(
      `INSERT INTO app.workspaces (id, created_by, soul_commit, soul_bucket, soul_key, name)
      VALUES ($1, $2, 'initial-commit', 'disposable-bucket', 'disposable-key', 'Private workspace')`,
      [workspace.id, workspace.userId],
    );
  }
  const registryLogin = registry => {
    const url = new URL(connectionString);
    url.username = registry.role;
    url.password = registry.password;
    return url.href;
  };
  async function verifyRegistry(registry, phase) {
    const { capability, role, client } = registry;
    const prefix = `${capability} registry ${phase}`;
    const credential = capability === 'authoring' ? 'runtime' : capability;
    await check(`${prefix} direct restricted login`, () => directIdentity(client, role));
    await check(`${prefix} only own ciphertext resolves to direct workspace login`, async () => {
      const rows = (
        await client.query(`SELECT workspace_id, generation, stage, ${credential}_credential AS credential
        FROM app.workspace_storage ORDER BY workspace_id`)
      ).rows;
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.stage, 'ready');
        const workspace = workspaces.find(item => item.id === row.workspace_id);
        assert.ok(workspace);
        const url = decryptCredential(
          row.credential,
          { workspaceId: workspace.id, generation: row.generation, capability: credential },
          credentialKeyring(credential),
        );
        const resolved = await connect(url);
        try {
          await directIdentity(resolved, workspace.names[credential]);
          assert.equal(
            (
              await resolved.query(
                `SELECT count(*)::integer AS count FROM ${qualified(workspace.names.schema, 'tf_common_migrations')}`,
              )
            ).rows[0].count,
            migrations.length,
          );
        } finally {
          await resolved.end();
          clients.delete(resolved);
        }
      }
    });
    if (capability === 'authoring') {
      await check(`${prefix} permitted authoring metadata`, async () => {
        const rows = (
          await client.query(
            'SELECT id, created_by, created_at, soul_commit, soul_bucket, soul_key FROM app.workspaces ORDER BY id',
          )
        ).rows;
        assert.equal(rows.length, 2);
        for (const row of rows) {
          assert.equal(row.created_by, workspaces.find(item => item.id === row.id)?.userId);
          assert.ok(row.created_at instanceof Date);
          assert.equal(row.soul_commit, 'initial-commit');
          assert.equal(row.soul_bucket, 'disposable-bucket');
          assert.equal(row.soul_key, 'disposable-key');
        }
      });
    } else {
      for (const column of ['id', 'created_by', 'created_at', 'soul_commit', 'soul_bucket', 'soul_key']) {
        await deny(client, `${prefix} denies authoring ${column}`, `SELECT ${column} FROM app.workspaces`);
      }
    }
    for (const other of ['runtime', 'migration', 'confirmation'].filter(value => value !== credential)) {
      await deny(
        client,
        `${prefix} denies ${other} ciphertext`,
        `SELECT ${other}_credential FROM app.workspace_storage`,
      );
    }
    for (const [name, sql] of [
      ['whole registry read', 'SELECT * FROM app.workspace_storage'],
      ['workspace name', 'SELECT name FROM app.workspaces'],
      ['accounts', 'SELECT * FROM app.accounts'],
      ['operator receipts', 'SELECT * FROM app.workspace_storage_operations'],
      ['registry generation write', 'UPDATE app.workspace_storage SET generation = 99'],
      ['own credential write', `UPDATE app.workspace_storage SET ${credential}_credential = '{}'`],
      ['registry insert', 'INSERT INTO app.workspace_storage DEFAULT VALUES'],
      ['registry delete', 'DELETE FROM app.workspace_storage'],
      ['authoring write', "UPDATE app.workspaces SET soul_commit = 'forged'"],
      ['app CREATE', 'CREATE TABLE app.registry_attack (id integer)'],
      ['public CREATE', 'CREATE TABLE public.registry_attack (id integer)'],
      ['temporary CREATE', 'CREATE TEMP TABLE registry_attack (id integer)'],
      ['schema CREATE', 'CREATE SCHEMA registry_attack'],
      ['provisioner SET ROLE', `SET ROLE ${ident(provisioner)}`],
      ['session authorization', `SET SESSION AUTHORIZATION ${ident(provisioner)}`],
    ])
      await deny(client, `${prefix} denies ${name}`, sql);
    for (const workspace of workspaces) {
      for (const table of [
        'tf_memberships',
        'tf_agents',
        'tf_invitations',
        'tf_retired_teams',
        'invoices',
        'future_invoices',
      ]) {
        await deny(
          client,
          `${prefix} denies ${workspace.label} ${table}`,
          `SELECT * FROM ${qualified(workspace.names.schema, table)}`,
        );
      }
      for (const role of [
        workspace.names.runtime,
        workspace.names.migration,
        workspace.names.confirmation,
        workspace.names.customOwner,
      ]) {
        await deny(client, `${prefix} denies SET ROLE ${role}`, `SET ROLE ${ident(role)}`);
      }
    }
    for (const other of registries.filter(item => item !== registry)) {
      await deny(client, `${prefix} denies ${other.capability} SET ROLE`, `SET ROLE ${ident(other.role)}`);
    }
  }
  for (const registry of registries) {
    stage = `provision ${registry.capability} registry`;
    await provisionTableRegistry(platform, registry);
    registryOids.set(
      registry.role,
      (await platform.query('SELECT oid FROM pg_roles WHERE rolname = $1', [registry.role])).rows[0].oid,
    );
    record(stage, 'PASS');
    registry.client = await connect(registryLogin(registry));
  }
  for (const registry of registries) {
    stage = `qualify ${registry.capability} registry`;
    await verifyRegistry(registry, 'initial');
    await check(`${registry.capability} registry replay repairs table column and future defaults`, async () => {
      await platform.query(`GRANT SELECT ON app.accounts TO ${ident(registry.role)};
        GRANT SELECT (name) ON app.workspaces TO ${ident(registry.role)}`);
      for (const scope of ['', 'IN SCHEMA app']) {
        for (const objects of ['TABLES', 'SEQUENCES', 'ROUTINES']) {
          await platform.query(
            `ALTER DEFAULT PRIVILEGES ${scope} GRANT ALL ON ${objects} TO ${ident(registry.role)}, PUBLIC`,
          );
        }
      }
      await provisionTableRegistry(platform, registry);
      await provisionTableRegistry(platform, registry);
    });
    const future = `app.future_${registry.capability}`;
    await platform.query(`CREATE TABLE ${future} (id bigserial, secret text);
      INSERT INTO ${future} (secret) VALUES ('disposable-only');
      CREATE FUNCTION ${future}() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT secret FROM ${future} LIMIT 1'`);
    for (const [name, sql] of [
      ['repaired account read', 'SELECT * FROM app.accounts'],
      ['repaired workspace name', 'SELECT name FROM app.workspaces'],
      ['future table', `SELECT * FROM ${future}`],
      ['future sequence read', `SELECT last_value FROM ${future}_id_seq`],
      ['future sequence use', `SELECT nextval('${future}_id_seq')`],
      ['future routine execution', `SELECT ${future}()`],
    ])
      await deny(registry.client, `${registry.capability} registry denies ${name}`, sql);
    for (const [grant, revoke] of [
      ['SELECT ON app.accounts', 'ALL ON app.accounts'],
      ['SELECT (secret) ON app.accounts', 'ALL (secret) ON app.accounts'],
      ['UPDATE (generation) ON app.workspace_storage', 'ALL (generation) ON app.workspace_storage'],
      [
        `SELECT (${registry.capability === 'migration' ? 'confirmation' : 'migration'}_credential) ON app.workspace_storage`,
        `ALL (${registry.capability === 'migration' ? 'confirmation' : 'migration'}_credential) ON app.workspace_storage`,
      ],
      [`USAGE ON SEQUENCE ${future}_id_seq`, `ALL ON SEQUENCE ${future}_id_seq`],
      [`EXECUTE ON FUNCTION ${future}()`, `ALL ON FUNCTION ${future}()`],
    ]) {
      await check(`${registry.capability} registry rejects ambient PUBLIC ${grant}`, async () => {
        await platform.query(`GRANT ${grant} TO PUBLIC`);
        try {
          await assert.rejects(provisionTableRegistry(platform, registry), /ambient privileges/);
        } finally {
          await platform.query(`REVOKE ${revoke} FROM PUBLIC`);
        }
        await provisionTableRegistry(platform, registry);
      });
    }
    await check(`${registry.capability} registry password rotation rejects old login`, async () => {
      const old = registryLogin(registry);
      registry.password = randomBytes(32).toString('hex');
      await provisionTableRegistry(platform, registry);
      await registry.client.end();
      clients.delete(registry.client);
      await rejectPassword(old);
      registry.client = await connect(registryLogin(registry));
      await directIdentity(registry.client, registry.role);
    });
  }

  stage = 'workspace credential rotation';
  const operator = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 15000 });
  operator.on('error', error => record('operator connection interrupted', 'FAIL', codeOf(error)));
  try {
    const workspace = workspaces[0];
    const otherBefore = (
      await platform.query('SELECT * FROM app.workspace_storage WHERE workspace_id = $1', [workspaces[1].id])
    ).rows;
    const command = {
      workspaceId: workspace.id,
      operationId: randomUUID(),
      expectedGeneration: 1,
      kind: 'rotate-passwords',
    };
    await check('workspace password rotation receipt and idempotent replay', async () => {
      assert.deepEqual(await rotateWorkspaceCredentials(operator, command), {
        workspaceId: workspace.id,
        operationId: command.operationId,
        generation: 2,
      });
      assert.deepEqual(await rotateWorkspaceCredentials(operator, command), {
        workspaceId: workspace.id,
        operationId: command.operationId,
        generation: 2,
      });
      assert.equal(
        (await platform.query('SELECT * FROM app.workspace_storage_operations WHERE workspace_id = $1', [workspace.id]))
          .rowCount,
        1,
      );
    });
    for (const capability of ['runtime', 'migration', 'confirmation']) {
      await check(`${capability} old workspace password rejected after rotation`, () =>
        rejectPassword(login(workspace, capability)),
      );
    }
    await check('stale rotation generation and changed operation replay rejected', async () => {
      await assert.rejects(
        rotateWorkspaceCredentials(operator, { ...command, operationId: randomUUID() }),
        WorkspaceOperatorConflict,
      );
      await assert.rejects(
        rotateWorkspaceCredentials(operator, { ...command, kind: 'rotate-keys' }),
        WorkspaceOperatorConflict,
      );
    });
    for (const registry of registries) await verifyRegistry(registry, 'password-rotated');
    await check('key rotation rewrap and idempotent receipt', async () => {
      const before = (
        await platform.query('SELECT * FROM app.workspace_storage WHERE workspace_id = $1', [workspace.id])
      ).rows[0];
      const urls = {};
      for (const capability of ['runtime', 'migration', 'confirmation']) {
        const oldKey = credentialKeyring(capability);
        urls[capability] = decryptCredential(
          before[`${capability}_credential`],
          { workspaceId: workspace.id, generation: 2, capability },
          oldKey,
        );
        const prefix = `WORKSPACE_${capability.toUpperCase()}`;
        process.env[`${prefix}_PREVIOUS_KEYS`] = JSON.stringify({ [oldKey.keyId]: oldKey.key.toString('hex') });
        process.env[`${prefix}_KEY`] = randomBytes(32).toString('hex');
        process.env[`${prefix}_KEY_ID`] = 'qualification-v2';
      }
      const rewrap = { ...command, operationId: randomUUID(), expectedGeneration: 2, kind: 'rotate-keys' };
      const expected = { workspaceId: workspace.id, operationId: rewrap.operationId, generation: 3 };
      assert.deepEqual(await rotateWorkspaceCredentials(operator, rewrap), expected);
      assert.deepEqual(await rotateWorkspaceCredentials(operator, rewrap), expected);
      const after = (
        await platform.query('SELECT * FROM app.workspace_storage WHERE workspace_id = $1', [workspace.id])
      ).rows[0];
      for (const capability of ['runtime', 'migration', 'confirmation']) {
        assert.equal(after[`${capability}_credential`].keyId, 'qualification-v2');
        assert.equal(
          decryptCredential(
            after[`${capability}_credential`],
            { workspaceId: workspace.id, generation: 3, capability },
            credentialKeyring(capability),
          ),
          urls[capability],
        );
      }
      assert.equal(
        (await platform.query('SELECT * FROM app.workspace_storage_operations WHERE workspace_id = $1', [workspace.id]))
          .rowCount,
        2,
      );
    });
    for (const registry of registries) await verifyRegistry(registry, 'key-rotated');
    await check('rotation preserves other workspace credentials and receipts', async () => {
      assert.deepEqual(
        (await platform.query('SELECT * FROM app.workspace_storage WHERE workspace_id = $1', [workspaces[1].id])).rows,
        otherBefore,
      );
      assert.equal(
        (
          await platform.query('SELECT * FROM app.workspace_storage_operations WHERE workspace_id = $1', [
            workspaces[1].id,
          ])
        ).rowCount,
        0,
      );
    });
  } finally {
    await operator.end();
  }
} catch (error) {
  record(stage, 'BLOCKED', codeOf(error));
} finally {
  await cleanup();
  const failed = results.filter(({ status }) => status !== 'PASS');
  emit({
    event: 'summary',
    status: failed.length ? 'FAIL' : 'PASS',
    passed: results.length - failed.length,
    failed: failed.length,
  });
  const evidence = `qualification-final-${target}-${token}.json`;
  writeFileSync(new URL(`./${evidence}`, import.meta.url), `${JSON.stringify(events, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ event: 'evidence', file: `apps/database/test/${evidence}` })}\n`);
  process.exitCode = failed.length ? 1 : 0;
}
import { provisionTestPgvector } from '../../../packages/workspace-storage/test/integration/pgvector.fixture.mjs';
