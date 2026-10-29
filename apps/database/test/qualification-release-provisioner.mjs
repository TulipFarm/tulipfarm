import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, escapeIdentifier as ident, escapeLiteral as literal } from 'pg';
import { configureStorageReleaseLogin, inspectStorageReleaseLogins } from '../src/storage-release-production.ts';
import { releaseLogins, StorageReleaseError } from '../src/storage-release.ts';
import {
  provisionWorkspace,
  qualified,
  workspaceNames,
  withMaintenanceTransaction,
} from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';

const target = process.argv[2];
assert.ok(['local', 'azure'].includes(target));
assert.deepEqual(process.argv.slice(3), ['--create-disposable-database']);
const token = randomBytes(12).toString('hex');
const database = `release_qual_${token}`;
const owner = `${database}_owner`;
const logins = ['provisioning', 'authoring', 'confirmation', 'migration'].map(capability => ({
  capability,
  role: `${database}_${capability}`,
  secret: `qualification-${token}-${capability}`,
}));
const provisioner = logins[0].role;
const workspaceId = randomUUID(),
  membershipId = randomUUID(),
  userId = randomUUID();
const names = workspaceNames(workspaceId);
const workspaceRoles = ['runtime', 'migration', 'confirmation', 'customOwner'].map(key => names[key]);
const passwords = Object.fromEntries(
  [...logins.map(login => login.role), ...workspaceRoles].map(role => [role, randomBytes(32).toString('hex')]),
);
const markers = new Map([
  [owner, `tulipfarm.qualification.${token}`],
  ...logins.map(login => [
    login.role,
    login.capability === 'provisioning'
      ? 'tulipfarm.storage-release.provisioning.v1'
      : `tulipfarm.table-registry.${login.capability}`,
  ]),
  ...workspaceRoles.map(role => [role, `tulipfarm.workspace.${workspaceId}`]),
]);
assert.ok([...markers.keys()].every(role => !releaseLogins.some(login => login.role === role)));
const events = [],
  clients = new Set(),
  roleOids = new Map();
const evidence = join(
  process.env.RELEASE_QUALIFICATION_ARTIFACTS ?? tmpdir(),
  `qualification-release-provisioner-${target}-${token}.json`,
);
writeFileSync(evidence, '[]\n', { flag: 'wx' });
let admin,
  dbAdmin,
  databaseOid,
  stage = 'configuration',
  interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
});
process.on('SIGTERM', () => {
  interrupted = true;
});
const emit = event => {
  const entry = { timestamp: new Date().toISOString(), target, ...event };
  events.push(entry);
  writeFileSync(evidence, `${JSON.stringify(events, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};
const errorDetails = error => ({
  code: typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNCLASSIFIED',
  ...(error instanceof StorageReleaseError ? { reason: error.message } : {}),
});
async function check(name, operation) {
  stage = name;
  if (interrupted) throw Object.assign(new Error(), { code: 'INTERRUPTED' });
  await operation();
  emit({ event: 'check', name, status: 'PASS' });
}
async function open(url) {
  const client = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
    lock_timeout: 5000,
    application_name: database,
  });
  client.on('error', error => emit({ event: 'connection-error', status: 'FAIL', ...errorDetails(error) }));
  clients.add(client);
  await client.connect();
  return client;
}
async function identify(client, role) {
  assert.deepEqual((await client.query('SELECT current_user, session_user, current_database() AS database')).rows, [
    { current_user: role, session_user: role, database },
  ]);
}
async function rememberRoles() {
  const rows = (
    await admin.query(
      "SELECT rolname, oid, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=ANY($1::text[])",
      [[...markers.keys()]],
    )
  ).rows;
  for (const row of rows) {
    assert.equal(row.marker, markers.get(row.rolname));
    if (roleOids.has(row.rolname)) assert.equal(row.oid, roleOids.get(row.rolname));
    else roleOids.set(row.rolname, row.oid);
  }
}
try {
  const paths = [
    'apps/database/test/qualification-release-provisioner.mjs',
    ...['storage-release', 'storage-release-production', 'storage-release-access'].map(
      name => `apps/database/src/${name}.ts`,
    ),
    ...['provisioning', 'migrations', 'names', 'transactions'].flatMap(name => [
      `packages/workspace-storage/src/${name}.ts`,
      `packages/workspace-storage/dist/${name}.js`,
    ]),
    ...['table-migrations', 'table-registry'].flatMap(name => [
      `packages/workspaces/src/${name}.ts`,
      `packages/workspaces/dist/${name}.js`,
    ]),
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
    'packages/workspace-storage/common/0015_image_generations.sql',
    'packages/workspace-storage/common/0016_recognition_receipts.sql',
    'packages/workspace-storage/common/0017_slack_image_deliveries.sql',
    'packages/workspace-storage/common/0018_confirmation_conversation_activity.sql',
    'packages/workspace-storage/common/0019_plan_source_checks.sql',
    'packages/workspace-storage/common/0020_system_packages.sql',
    'packages/workspace-storage/common/0021_system_package_attempts.sql',
    'packages/workspace-storage/common/0022_conversation_layouts.sql',
  ];
  emit({
    event: 'sources',
    sources: paths.map(path => ({
      path,
      sha256: createHash('sha256')
        .update(readFileSync(new URL(`../../../${path}`, import.meta.url)))
        .digest('hex'),
    })),
  });
  const url = new URL(process.env.DATABASE_ADMIN_URL);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.pathname, '/postgres');
  assert.equal(url.hash, '');
  if (target === 'azure') {
    assert.equal(url.hostname, 'tulipfarm-cloud.postgres.database.azure.com');
    assert.ok(['', '5432'].includes(url.port));
    assert.equal(url.username, 'tfadmin');
    assert.equal(url.search, '?sslmode=verify-full');
  } else {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.search, '');
  }
  const migrations = await workspaceTableMigrations();
  assert.deepEqual(
    migrations.map(row => row.name),
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
      '0015_image_generations.sql',
      '0016_recognition_receipts.sql',
      '0017_slack_image_deliveries.sql',
      '0018_confirmation_conversation_activity.sql',
      '0019_plan_source_checks.sql',
      '0020_system_packages.sql',
      '0021_system_package_attempts.sql',
      '0022_conversation_layouts.sql',
    ],
  );
  const receipts = migrations.map(({ name, checksum }) => ({ name, checksum }));
  emit({ event: 'objects', database, owner, logins, workspaceId, names });
  emit({ event: 'common-stream', version: migrations.length, migrations: receipts });
  admin = await open(url);
  emit({
    event: 'server',
    ...(
      await admin.query(
        "SELECT version(), current_user, current_database(), current_setting('server_version_num') AS version_num",
      )
    ).rows[0],
  });
  await check('all random database and role names absent', async () => {
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0);
    assert.equal(
      (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [[...markers.keys()]])).rowCount,
      0,
    );
  });
  await check('separate marked database owner and private database', async () => {
    await admin.query(
      `CREATE ROLE ${ident(owner)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`COMMENT ON ROLE ${ident(owner)} IS ${literal(markers.get(owner))}`);
    await rememberRoles();
    const administrator = (await admin.query('SELECT current_user')).rows[0].current_user;
    await admin.query(`GRANT ${ident(owner)} TO ${ident(administrator)} WITH INHERIT FALSE, SET TRUE`);
    await admin.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(owner)}`);
    await provisionTestPgvector(admin, database);
    databaseOid = (await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [database])).rows[0].oid;
    url.pathname = `/${database}`;
    dbAdmin = await open(url);
    await dbAdmin.query(
      `REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
    );
    await dbAdmin.query(`CREATE SCHEMA app; REVOKE ALL ON SCHEMA app FROM PUBLIC;
      CREATE SCHEMA database_management; REVOKE ALL ON SCHEMA database_management FROM PUBLIC;
      CREATE TABLE app.accounts (secret text); INSERT INTO app.accounts VALUES ('disposable');
      CREATE TABLE app.workspaces (id uuid, created_by text, created_at timestamptz, soul_commit text, soul_bucket text, soul_key text, ready_at timestamptz, name text);
      CREATE TABLE app.workspace_storage (workspace_id uuid, generation integer, stage text, runtime_credential jsonb, migration_credential jsonb, confirmation_credential jsonb);
      CREATE TABLE app.workspace_storage_operations (workspace_id uuid, operation_id uuid)`);
    await dbAdmin.query(
      "CREATE FUNCTION app.invitation_delivery(workspace uuid, invitation uuid, action text, envelope jsonb DEFAULT NULL, expiry timestamptz DEFAULT NULL) RETURNS void LANGUAGE sql AS 'SELECT'; REVOKE ALL ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) FROM PUBLIC",
    );
  });
  const loginUrl = role => {
    const value = new URL(url);
    value.username = role;
    value.password = passwords[role];
    return value;
  };
  await check('actual release helper configures nonowner provisioner', async () => {
    await configureStorageReleaseLogin(dbAdmin, logins[0], passwords[provisioner], logins);
    await rememberRoles();
    const client = await open(loginUrl(provisioner));
    await identify(client, provisioner);
    assert.deepEqual(
      (
        await client.query(`SELECT d.datdba=current_user::regrole AS owner,
      has_database_privilege(current_user,d.oid,'CONNECT WITH GRANT OPTION') AS delegate_connect,
      has_database_privilege(current_user,d.oid,'CREATE') AS create_schema,
      has_database_privilege(current_user,d.oid,'TEMPORARY') AS temporary
      FROM pg_database d WHERE datname=current_database()`)
      ).rows,
      [{ owner: false, delegate_connect: true, create_schema: true, temporary: false }],
    );
    await assert.rejects(client.query('SELECT * FROM app.accounts'), { code: '42501' });
  });
  const provision = () =>
    provisionWorkspace({
      connectionString: loginUrl(provisioner).href,
      workspaceId,
      migrations,
      passwords: Object.fromEntries(
        ['runtime', 'migration', 'confirmation'].map(capability => [capability, passwords[names[capability]]]),
      ),
      initialAdmin: { userId, membershipId },
    });
  await check('real workspace provisioning through nonowner login', async () => {
    await provision();
    await rememberRoles();
  });
  emit({
    event: 'provisioner-memberships',
    rows: (
      await dbAdmin.query(
        `SELECT parent.rolname AS role, child.rolname AS member,
    m.admin_option, m.inherit_option, m.set_option, m.grantor, grantor.rolname AS grantor_name, grantor.rolsuper AS grantor_superuser
    FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member
    JOIN pg_roles grantor ON grantor.oid=m.grantor WHERE child.rolname=ANY($1::text[]) ORDER BY child.rolname,parent.rolname,m.grantor`,
        [[provisioner, ...workspaceRoles]],
      )
    ).rows,
  });
  await check('actual postuse ownership and membership inspection', () => inspectStorageReleaseLogins(dbAdmin, logins));
  await check(
    'pgvector delegation permits audited functions and rejects an unrelated extension-schema function',
    async () => {
      const client = await open(loginUrl(provisioner));
      await assert.rejects(client.query('CREATE EXTENSION file_fdw'), { code: '42501' });
      await assert.rejects(
        client.query('CREATE FUNCTION extensions.hostile() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'),
        { code: '42501' },
      );
      await dbAdmin.query('CREATE FUNCTION extensions.hostile() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
      await dbAdmin.query(`GRANT EXECUTE ON FUNCTION extensions.hostile() TO ${ident(provisioner)}`);
      await assert.rejects(inspectStorageReleaseLogins(dbAdmin, logins), /unexpected object privileges/);
      await dbAdmin.query('DROP FUNCTION extensions.hostile()');
      await inspectStorageReleaseLogins(dbAdmin, logins);
    },
  );
  for (const capability of ['runtime', 'migration', 'confirmation']) {
    await check(
      `${capability} direct login with PUBLIC CONNECT revoked and exact ${receipts.length} receipts`,
      async () => {
        const client = await open(loginUrl(names[capability]));
        await identify(client, names[capability]);
        assert.deepEqual(
          (
            await client.query(
              `SELECT name, checksum FROM ${qualified(names.schema, 'tf_common_migrations')} ORDER BY name`,
            )
          ).rows,
          receipts,
        );
        await assert.rejects(client.query('SELECT * FROM app.accounts'), { code: '42501' });
      },
    );
  }
  await check('migration custom owner creates table and runtime uses grants', async () => {
    await withMaintenanceTransaction({
      connectionString: loginUrl(names.migration).href,
      workspaceId,
      capability: 'migration',
      operation: ({ client }) =>
        client.query(`CREATE TABLE ${qualified(names.schema, 'probe')} (id integer PRIMARY KEY)`),
    });
    const runtime = await open(loginUrl(names.runtime));
    await runtime.query(`INSERT INTO ${qualified(names.schema, 'probe')} VALUES (1)`);
    assert.deepEqual((await runtime.query(`SELECT * FROM ${qualified(names.schema, 'probe')}`)).rows, [{ id: 1 }]);
  });
  await check('provisioner reconciliation and workspace retry preserve inspection and admission', async () => {
    await configureStorageReleaseLogin(dbAdmin, logins[0], passwords[provisioner], logins);
    await provision();
    await inspectStorageReleaseLogins(dbAdmin, logins);
    assert.deepEqual(
      (await dbAdmin.query(`SELECT id,user_id FROM ${qualified(names.schema, 'tf_memberships')}`)).rows,
      [{ id: membershipId, user_id: userId }],
    );
  });
  await dbAdmin.query(
    `INSERT INTO app.workspace_storage VALUES ($1,1,'ready','{"capability":"runtime"}','{"capability":"migration"}','{"capability":"confirmation"}')`,
    [workspaceId],
  );
  await dbAdmin.query(`INSERT INTO app.workspaces (id,created_by,name) VALUES ($1,$2,'private')`, [
    workspaceId,
    userId,
  ]);
  for (const login of logins.slice(1)) {
    await check(`${login.capability} registry actual configuration replay and direct capability boundary`, async () => {
      await configureStorageReleaseLogin(dbAdmin, login, passwords[login.role], logins);
      await rememberRoles();
      await configureStorageReleaseLogin(dbAdmin, login, passwords[login.role], logins);
      const client = await open(loginUrl(login.role));
      await identify(client, login.role);
      const capability = login.capability === 'authoring' ? 'runtime' : login.capability;
      assert.deepEqual(
        (
          await client.query(
            `SELECT workspace_id,generation,stage,${capability}_credential AS credential FROM app.workspace_storage`,
          )
        ).rows,
        [{ workspace_id: workspaceId, generation: 1, stage: 'ready', credential: { capability } }],
      );
      for (const other of ['runtime', 'migration', 'confirmation'].filter(value => value !== capability)) {
        await assert.rejects(client.query(`SELECT ${other}_credential FROM app.workspace_storage`), { code: '42501' });
      }
      for (const sql of [
        'SELECT * FROM app.accounts',
        'SELECT name FROM app.workspaces',
        'UPDATE app.workspace_storage SET generation=2',
        `SELECT * FROM ${qualified(names.schema, 'tf_memberships')}`,
        `SET ROLE ${ident(provisioner)}`,
      ]) {
        await assert.rejects(client.query(sql), { code: '42501' });
      }
      if (login.capability === 'authoring')
        assert.deepEqual((await client.query('SELECT id,created_by FROM app.workspaces')).rows, [
          { id: workspaceId, created_by: userId },
        ]);
      else await assert.rejects(client.query('SELECT id FROM app.workspaces'), { code: '42501' });
    });
  }
  await check('final actual inspection after all registry configuration', () =>
    inspectStorageReleaseLogins(dbAdmin, logins),
  );
} catch (error) {
  emit({ event: 'check', name: stage, status: 'FAIL', ...errorDetails(error) });
} finally {
  for (const client of clients)
    if (client !== admin)
      await client.end().catch(error => emit({ event: 'close', status: 'FAIL', ...errorDetails(error) }));
  if (admin) {
    try {
      await rememberRoles();
      if (databaseOid) {
        const row = (
          await admin.query('SELECT oid,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [database])
        ).rows[0];
        assert.deepEqual(row, { oid: databaseOid, owner });
        await admin.query(`DROP DATABASE ${ident(database)}`);
      }
      if (roleOids.has(provisioner)) {
        const administrator = (await admin.query('SELECT current_user')).rows[0].current_user;
        await admin.query(`GRANT ${ident(provisioner)} TO ${ident(administrator)} WITH INHERIT FALSE, SET TRUE`);
        await admin.query(`SET ROLE ${ident(provisioner)}`);
        try {
          for (const role of workspaceRoles) if (roleOids.has(role)) await admin.query(`DROP ROLE ${ident(role)}`);
        } finally {
          await admin.query('RESET ROLE');
        }
      }
      for (const role of [...logins.slice(1).map(login => login.role), provisioner, owner]) {
        if (roleOids.has(role)) await admin.query(`DROP ROLE ${ident(role)}`);
      }
      const remainingRoles = (
        await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])', [[...markers.keys()]])
      ).rows;
      const remainingDatabases = (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [database]))
        .rows;
      assert.deepEqual(remainingRoles, []);
      assert.deepEqual(remainingDatabases, []);
      emit({
        event: 'cleanup',
        status: 'PASS',
        database,
        roles: [...markers.keys()],
        remainingRoles,
        remainingDatabases,
      });
    } catch (error) {
      emit({ event: 'cleanup', status: 'FAIL', database, ...errorDetails(error) });
    }
    await admin.end();
  }
  const failed = events.filter(event => event.status === 'FAIL').length;
  emit({
    event: 'summary',
    status: failed ? 'FAIL' : 'PASS',
    passed: events.filter(event => event.event === 'check' && event.status === 'PASS').length,
    failed,
  });
  process.exitCode = failed ? 1 : 0;
}
import { provisionTestPgvector } from '../../../packages/workspace-storage/test/integration/pgvector.fixture.mjs';
