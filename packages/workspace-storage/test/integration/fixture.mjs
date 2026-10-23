import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import { provisionWorkspace, readMigrations, workspaceNames } from '../../src/provisioning.ts';
import { installCreditAccount } from '../../src/credit-account.ts';
import { installExtensions } from '../../../../apps/database/src/extensions.ts';
import { grantPgvector } from '../../src/pgvector.ts';

export async function connect(connectionString) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  await client.connect();
  return client;
}

export async function seedPlatformUser(
  client,
  {
    id = randomUUID(),
    name = 'Test',
    email = `${id.replaceAll('-', '')}@example.test`,
    emailVerified = true,
    image = null,
  } = {},
) {
  await client.query(
    `INSERT INTO app.users(id,name,email,email_verified,image) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [id, name, email, emailVerified, image],
  );
  return id;
}

export async function seedPlatformAccount(
  client,
  { id = randomUUID(), userId, accountId = randomUUID(), providerId, accessToken = null, refreshToken = null },
) {
  await client.query(
    `INSERT INTO app.accounts(id,user_id,account_id,provider_id,access_token,refresh_token,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)`,
    [id, userId, accountId, providerId, accessToken, refreshToken],
  );
  return id;
}

export async function registerPlatformWorkspace(client, id, userId) {
  const owner = await seedPlatformUser(client, { id: userId ?? randomUUID() });
  await client.query(
    `INSERT INTO app.workspaces (id, request_id, created_by, name, slug) VALUES ($1::uuid, gen_random_uuid(), $2::uuid, 'Test', 'ws-' || replace($1::uuid::text,'-','')) ON CONFLICT (id) DO NOTHING`,
    [id, owner],
  );
  await client.query(`INSERT INTO app.workspace_storage (workspace_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`, [id]);
}

export async function markWorkspaceReady(client, id) {
  await registerPlatformWorkspace(client, id);
  await client.query(
    "UPDATE app.workspace_storage SET stage='ready', runtime_credential='{}', migration_credential='{}', confirmation_credential='{}' WHERE workspace_id=$1",
    [id],
  );
}

export async function loadPlatformBaseline(client) {
  if ((await client.query("SELECT to_regclass('app.users') AS users")).rows[0].users) return;
  const sql = await readFile(
    new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url),
    'utf8',
  );
  await client.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;\n${sql}`);
}

export async function fixture() {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL, 'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server');
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Integration tests only accept a local database host',
  );
  assert.equal(url.search, '', 'Local database URL must not override its destination');
  const admin = await connect(url.href);
  const token = randomUUID().replaceAll('-', '');
  const database = `storage_test_${token}`;
  const owner = `storage_owner_${token}`;
  const password = randomBytes(32).toString('hex');
  const workspaces = [];
  await admin.query(
    `CREATE ROLE ${escapeIdentifier(owner)} LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`,
  );
  await admin.query(`CREATE DATABASE ${escapeIdentifier(database)} OWNER ${escapeIdentifier(owner)}`);
  url.pathname = `/${database}`;
  const databaseAdmin = await connect(url.href);
  await installExtensions(databaseAdmin, false);
  await grantPgvector(databaseAdmin, owner, true);
  await databaseAdmin.query(`REVOKE ALL ON DATABASE ${escapeIdentifier(database)} FROM PUBLIC`);
  await databaseAdmin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  url.username = owner;
  url.password = password;
  const connectionString = url.href;
  const platform = await connect(connectionString);
  await platform.query(
    "CREATE SCHEMA app; REVOKE ALL ON SCHEMA app FROM PUBLIC; CREATE TABLE app.accounts (id integer PRIMARY KEY, secret text); INSERT INTO app.accounts VALUES (1, 'platform-only')",
  );
  const baseline = await readMigrations();
  function login(workspace, capability = 'runtime') {
    const credential = new URL(connectionString);
    credential.username = workspace.names[capability];
    credential.password = workspace.passwords[capability];
    return credential.href;
  }
  async function create(migrations = baseline, initialAdmin = {}) {
    const workspace = {
      id: randomUUID(),
      passwords: {
        runtime: randomBytes(32).toString('hex'),
        migration: randomBytes(32).toString('hex'),
        confirmation: randomBytes(32).toString('hex'),
      },
      userId: initialAdmin.userId ?? randomUUID(),
      membershipId: initialAdmin.membershipId ?? randomUUID(),
    };
    workspace.names = workspaceNames(workspace.id);
    workspaces.push(workspace);
    await platform.query(`DO $$ BEGIN IF to_regprocedure('app.invitation_delivery(uuid,uuid,text,jsonb,timestamptz)') IS NULL THEN
      CREATE FUNCTION app.invitation_delivery(workspace uuid, invitation uuid, action text, envelope jsonb DEFAULT NULL, expiry timestamptz DEFAULT NULL) RETURNS void LANGUAGE sql AS 'SELECT';
      REVOKE ALL ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) FROM PUBLIC; END IF; END $$`);
    await provisionWorkspace({
      connectionString,
      workspaceId: workspace.id,
      passwords: workspace.passwords,
      initialAdmin: { userId: workspace.userId, membershipId: workspace.membershipId },
      migrations,
    });
    // Credit tests exercise the optional billing balance, which the common migrations no longer create.
    await installCreditAccount(platform, workspace.id);
    await registerPlatform();
    return workspace;
  }
  async function registerPlatform() {
    if (!(await platform.query("SELECT to_regclass('app.workspace_storage') AS present")).rows[0].present) return;
    for (const { id, userId } of workspaces) await registerPlatformWorkspace(platform, id, userId);
  }
  async function close() {
    try {
      await platform.end();
      await databaseAdmin.end();
      // DROP DATABASE waits for a forced checkpoint, which can outlast the test statement timeout on a busy server.
      await admin.query('SET statement_timeout = 0');
      await admin.query(`DROP DATABASE ${escapeIdentifier(database)} WITH (FORCE)`);
      for (const workspace of workspaces) {
        for (const key of ['runtime', 'migration', 'confirmation', 'customOwner'])
          await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(workspace.names[key])}`);
      }
      await admin.query(`DROP ROLE ${escapeIdentifier(owner)}`);
    } finally {
      // An open admin socket would keep the test process alive after a failed teardown.
      await admin.end();
    }
  }
  return {
    admin,
    databaseAdmin,
    platform,
    owner,
    connectionString,
    baseline,
    workspaces,
    create,
    registerPlatform,
    login,
    close,
  };
}

export async function denied(client, sql, values = []) {
  await assert.rejects(client.query(sql, values), error => error.code === '42501', sql);
}
