import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { provisionWorkspace } from '@tulipfarm/workspace-storage/provisioning';
import { readMigrations as readGlobalMigrations } from '../src/migrations.ts';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import {
  checkStorageReleasePrerequisites,
  configureStorageReleaseLogin,
  inspectStorageReleaseLogins,
} from '../src/storage-release-production.ts';
import { releaseLogins, runStorageRelease } from '../src/storage-release.ts';
import { encryptCredential } from '../../../packages/workspaces/src/credentials.ts';
import { inspectProvisionerAccess, inspectProvisionerWorkspaces } from '../src/storage-release-access.ts';

const exec = promisify(execFile);

test(
  'disposable PostgreSQL proves legacy refusal, installed gates, scoped login retries and capability grants',
  { timeout: 120000 },
  async t => {
    const container = `storage-release-${randomUUID()}`;
    const clients = [];
    try {
      await exec('docker', [
        'run',
        '--detach',
        '--rm',
        '--name',
        container,
        '-e',
        'POSTGRES_PASSWORD=disposable-release-password',
        '-p',
        '127.0.0.1::5432',
        'pgvector/pgvector:0.8.2-pg18',
      ]);
      const { stdout } = await exec('docker', ['port', container, '5432/tcp']);
      const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
      assert.ok(port);
      for (let attempt = 0; ; attempt++) {
        try {
          await exec('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
          break;
        } catch (error) {
          if (attempt === 60) throw error;
          await setTimeout(250);
        }
      }
      let url = `postgresql://postgres:disposable-release-password@127.0.0.1:${port}/postgres`;
      async function open(value) {
        const client = new Client({ connectionString: value });
        await client.connect();
        clients.push(client);
        return client;
      }
      const admin = await open(url);
      await admin.query('CREATE ROLE separate_database_owner NOLOGIN');
      await admin.query('CREATE DATABASE release_test OWNER separate_database_owner');
      await provisionTestPgvector(admin, 'release_test');
      const databaseUrl = new URL(url);
      databaseUrl.pathname = '/release_test';
      url = databaseUrl.href;
      const client = await open(url);
      await client.query('REVOKE ALL ON DATABASE release_test FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await client.query(
        'CREATE SCHEMA database_management; CREATE TABLE database_management.migrations (name text PRIMARY KEY, checksum text NOT NULL)',
      );
      const migrations = await readGlobalMigrations(new URL('../migrations/', import.meta.url).pathname);
      for (const migration of migrations.slice(0, 3)) {
        await client.query('SET search_path = app, public');
        await client.query(migration.sql);
        await client.query('INSERT INTO database_management.migrations VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
      }
      const userId = randomUUID();
      const workspaceId = randomUUID();
      await client.query(
        "INSERT INTO app.users (id, name, email, email_verified) VALUES ($1, 'Preserve', 'preserve@example.test', false)",
        [userId],
      );
      await client.query(
        "INSERT INTO app.workspaces (id, request_id, created_by, name, slug) VALUES ($1, $2, $3, 'Preserve', 'preserve')",
        [workspaceId, randomUUID(), userId],
      );
      const before = (await client.query('SELECT * FROM app.workspaces')).rows;
      const rolesBefore = (await client.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows;
      for (const kind of ['keys', 'logins'])
        for (const apply of [false, true]) {
          await assert.rejects(
            runStorageRelease(
              { kind, apply, days: 30, expectedCurrent: 7 },
              {
                prerequisites: () => checkStorageReleasePrerequisites(client, migrations),
                readSecret: () => assert.fail('secret access after blocked preflight'),
                saveSecret: () => assert.fail('secret write after blocked preflight'),
                setRetention: () => assert.fail('Azure write after blocked preflight'),
                configureLogin: () => assert.fail('role write after blocked preflight'),
              },
            ),
            /targeted cutover/,
          );
        }
      assert.deepEqual((await client.query('SELECT * FROM app.workspaces')).rows, before);
      assert.deepEqual((await client.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows, rolesBefore);
      assert.equal((await client.query('SELECT * FROM database_management.migrations')).rowCount, 3);
      await client.query('BEGIN');
      await client.query('DELETE FROM app.workspaces');
      await client.query('COMMIT');
      await assert.rejects(checkStorageReleasePrerequisites(client, migrations), /required migrations/);
      for (const migration of migrations.slice(3)) {
        await client.query(migration.sql);
        await client.query('INSERT INTO database_management.migrations VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
      }
      await client.query('CREATE TABLE database_management.storage_capabilities (capability text PRIMARY KEY)');
      await assert.rejects(checkStorageReleasePrerequisites(client, migrations), /installed isolated-v1/);
      await client.query("INSERT INTO database_management.storage_capabilities VALUES ('isolated-v1')");
      await client.query(
        "UPDATE database_management.migrations SET checksum = 'drift' WHERE name = '0001_baseline.sql'",
      );
      await assert.rejects(checkStorageReleasePrerequisites(client, migrations), /drifted/);
      await client.query('UPDATE database_management.migrations SET checksum = $1 WHERE name = $2', [
        migrations[0].checksum,
        migrations[0].name,
      ]);
      assert.deepEqual(await checkStorageReleasePrerequisites(client, migrations), { credentialsExist: false });
      await client.query('CREATE ROLE tulipfarm_storage_authoring');
      await assert.rejects(inspectStorageReleaseLogins(client), /Unexpected/);
      await client.query('DROP ROLE tulipfarm_storage_authoring');
      await inspectStorageReleaseLogins(client);
      const password = 'disposable-scoped-release-password';
      for (const login of releaseLogins) {
        await configureStorageReleaseLogin(client, login, password);
        await configureStorageReleaseLogin(client, login, password);
        const loginUrl = new URL(url);
        loginUrl.username = login.role;
        loginUrl.password = password;
        const scoped = await open(loginUrl.href);
        assert.equal((await scoped.query('SELECT current_user')).rows[0].current_user, login.role);
        await assert.rejects(scoped.query('SELECT * FROM app.users'), { code: '42501' });
        await assert.rejects(scoped.query("INSERT INTO database_management.storage_capabilities VALUES ('forged')"), {
          code: '42501',
        });
        if (login.capability === 'provisioning') {
          const attrs = (
            await scoped.query(
              'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = current_user',
            )
          ).rows[0];
          assert.deepEqual(attrs, {
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: true,
            rolreplication: false,
            rolbypassrls: false,
            rolinherit: false,
          });
          await scoped.query('SELECT * FROM app.workspace_storage');
        } else {
          const column = login.capability === 'authoring' ? 'runtime_credential' : `${login.capability}_credential`;
          await scoped.query(`SELECT workspace_id, ${column} FROM app.workspace_storage`);
          for (const other of ['runtime_credential', 'migration_credential', 'confirmation_credential'].filter(
            value => value !== column,
          )) {
            await assert.rejects(scoped.query(`SELECT ${other} FROM app.workspace_storage`), { code: '42501' });
          }
          await assert.rejects(scoped.query('CREATE TABLE app.forbidden (id integer)'), { code: '42501' });
        }
      }
      const provisioningUrl = new URL(url);
      provisioningUrl.username = releaseLogins[0].role;
      provisioningUrl.password = password;
      const membershipId = randomUUID();
      const common = await workspaceTableMigrations();
      const names = await provisionWorkspace({
        connectionString: provisioningUrl.href,
        workspaceId,
        migrations: common,
        passwords: { runtime: password, migration: password, confirmation: password },
        initialAdmin: { userId, membershipId },
      });
      assert.equal(
        (
          await client.query('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1', [
            names.schema,
          ])
        ).rows[0].owner,
        releaseLogins[0].role,
      );
      await t.test('all workspace capabilities connect with PUBLIC CONNECT revoked', async () => {
        for (const capability of ['runtime', 'migration', 'confirmation']) {
          const workspaceUrl = new URL(url);
          workspaceUrl.username = names[capability];
          workspaceUrl.password = password;
          const scoped = await open(workspaceUrl.href);
          assert.equal((await scoped.query('SELECT current_user')).rows[0].current_user, names[capability]);
        }
      });
      await t.test('ordinary provisioning memberships permit inspection and reconciliation', async () => {
        await inspectStorageReleaseLogins(client);
        await configureStorageReleaseLogin(client, releaseLogins[0], password);
      });
      await assert.rejects(checkStorageReleasePrerequisites(client, migrations), /registry\/schema/);
      await t.test(
        'private table, column, inherited-owner and default privilege drift refuse reconciliation',
        async () => {
          await client.query(
            'CREATE SCHEMA private; CREATE TABLE private.secret (value text); REVOKE ALL ON SCHEMA private FROM PUBLIC',
          );
          for (const principal of [releaseLogins[0].role, names.customOwner]) {
            for (const privilege of ['SELECT', 'SELECT (value)']) {
              await client.query(`GRANT ${privilege} ON private.secret TO ${principal}`);
              await assert.rejects(
                configureStorageReleaseLogin(client, releaseLogins[0], password),
                /unexpected object/,
              );
              await client.query(`REVOKE ${privilege} ON private.secret FROM ${principal}`);
            }
            for (const scope of ['', 'IN SCHEMA private']) {
              await client.query(`ALTER DEFAULT PRIVILEGES ${scope} GRANT SELECT ON TABLES TO ${principal}`);
              await assert.rejects(
                configureStorageReleaseLogin(client, releaseLogins[0], password),
                /unexpected default/,
              );
              await client.query(`ALTER DEFAULT PRIVILEGES ${scope} REVOKE SELECT ON TABLES FROM ${principal}`);
            }
          }
          await inspectStorageReleaseLogins(client);
        },
      );
      await t.test('unrelated memberships, elevated options and forged workspace markers are rejected', async () => {
        await client.query('CREATE ROLE unrelated_role NOLOGIN');
        await client.query(`GRANT unrelated_role TO ${releaseLogins[0].role}`);
        await assert.rejects(inspectStorageReleaseLogins(client), /unexpected role membership/);
        await client.query(`REVOKE unrelated_role FROM ${releaseLogins[0].role}`);
        await client.query(`GRANT ${names.runtime} TO ${releaseLogins[0].role} WITH INHERIT TRUE, SET TRUE`);
        await assert.rejects(inspectStorageReleaseLogins(client), /unexpected role membership/);
        await client.query(`GRANT ${names.runtime} TO ${releaseLogins[0].role} WITH INHERIT FALSE, SET FALSE`);
        await client.query(`COMMENT ON ROLE ${names.runtime} IS 'forged'`);
        await assert.rejects(inspectStorageReleaseLogins(client), /marker/);
        await client.query(`COMMENT ON ROLE ${names.runtime} IS 'tulipfarm.workspace.${workspaceId}'`);
        await inspectStorageReleaseLogins(client);
      });
      await t.test('missing creator, owner and migration memberships fail before reconciliation writes', async () => {
        for (const role of [names.runtime, names.migration, names.confirmation, names.customOwner]) {
          await client.query('BEGIN');
          try {
            await client.query(`REVOKE ADMIN OPTION FOR ${role} FROM ${releaseLogins[0].role} CASCADE`);
            await assert.rejects(inspectStorageReleaseLogins(client), /membership/);
          } finally {
            await client.query('ROLLBACK');
          }
        }
        const scoped = await open(provisioningUrl.href);
        for (const member of [releaseLogins[0].role, names.migration]) {
          await scoped.query('BEGIN');
          try {
            await scoped.query(`REVOKE ${names.customOwner} FROM ${member} GRANTED BY CURRENT_USER`);
            await assert.rejects(inspectStorageReleaseLogins(scoped), /membership/);
          } finally {
            await scoped.query('ROLLBACK');
          }
        }
        await client.query(`REVOKE ADMIN OPTION FOR ${names.runtime} FROM ${releaseLogins[0].role}`);
        await assert.rejects(configureStorageReleaseLogin(client, releaseLogins[0], password), /membership/);
        await client.query(
          `GRANT ${names.runtime} TO ${releaseLogins[0].role} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
        );
        await inspectStorageReleaseLogins(client);
      });
      await t.test('grant options on allowed tables and columns are forbidden', async () => {
        for (const [relation, privilege] of [
          ['app.workspace_storage', 'UPDATE'],
          ['app.workspaces', 'UPDATE (soul_key)'],
        ]) {
          await client.query(`GRANT ${privilege} ON ${relation} TO ${releaseLogins[0].role} WITH GRANT OPTION`);
          await assert.rejects(configureStorageReleaseLogin(client, releaseLogins[0], password), /unexpected object/);
          await client.query(`REVOKE GRANT OPTION FOR ${privilege} ON ${relation} FROM ${releaseLogins[0].role}`);
        }
        await inspectStorageReleaseLogins(client);
      });
      await t.test(
        'PUBLIC defaults ignore inaccessible unrelated schemas but reject reachable and global grants',
        async () => {
          await client.query(
            'CREATE ROLE unrelated_creator NOLOGIN; CREATE SCHEMA unrelated AUTHORIZATION unrelated_creator; REVOKE ALL ON SCHEMA unrelated FROM PUBLIC',
          );
          await client.query(
            'ALTER DEFAULT PRIVILEGES FOR ROLE unrelated_creator IN SCHEMA unrelated GRANT SELECT ON TABLES TO PUBLIC',
          );
          await configureStorageReleaseLogin(client, releaseLogins[0], password);
          await client.query(`GRANT USAGE ON SCHEMA unrelated TO ${releaseLogins[0].role}`);
          await assert.rejects(inspectStorageReleaseLogins(client), /unexpected default/);
          await client.query(`REVOKE USAGE ON SCHEMA unrelated FROM ${releaseLogins[0].role}`);
          await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE unrelated_creator GRANT SELECT ON TABLES TO PUBLIC');
          await assert.rejects(inspectStorageReleaseLogins(client), /unexpected default/);
          await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE unrelated_creator REVOKE SELECT ON TABLES FROM PUBLIC');
          await inspectStorageReleaseLogins(client);
        },
      );
      await t.test(
        'qualification uses only supplied login names and ignores other databases workspace roles',
        async () => {
          const suffix = randomUUID().replaceAll('-', '');
          const logins = releaseLogins.map(login => ({
            ...login,
            role: `q_${suffix}_${login.capability}`,
            secret: `q-${suffix}-${login.capability}`,
          }));
          await admin.query('CREATE DATABASE qualification_test OWNER separate_database_owner');
          await provisionTestPgvector(admin, 'qualification_test');
          const target = new URL(url);
          target.pathname = '/qualification_test';
          const qualification = await open(target.href);
          await qualification.query(
            'REVOKE ALL ON DATABASE qualification_test FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC',
          );
          await qualification.query('CREATE SCHEMA database_management');
          for (const migration of migrations) {
            await qualification.query('SET search_path = app, public');
            await qualification.query(migration.sql);
          }
          await assert.rejects(
            configureStorageReleaseLogin(qualification, releaseLogins[0], password, logins),
            /belong/,
          );
          await assert.rejects(inspectStorageReleaseLogins(qualification, [...logins.slice(0, 3), logins[0]]));
          await assert.rejects(inspectProvisionerWorkspaces(qualification, 'bad;role'));
          for (const login of logins) await configureStorageReleaseLogin(qualification, login, password, logins);
          target.username = logins[0].role;
          target.password = password;
          const workspace = await provisionWorkspace({
            connectionString: target.href,
            workspaceId: randomUUID(),
            migrations: common,
            passwords: { runtime: password, migration: password, confirmation: password },
            initialAdmin: { userId, membershipId: randomUUID() },
          });
          const scopes = await inspectProvisionerWorkspaces(qualification, logins[0].role);
          assert.deepEqual(
            scopes.map(scope => scope.schema),
            [workspace.schema],
          );
          await inspectProvisionerAccess(qualification, scopes, logins[0].role);
          await inspectStorageReleaseLogins(qualification, logins);
          for (const login of logins) await configureStorageReleaseLogin(qualification, login, password, logins);
          for (const capability of ['runtime', 'migration', 'confirmation']) {
            target.username = workspace[capability];
            const runtime = await open(target.href);
            assert.equal((await runtime.query('SELECT current_user')).rows[0].current_user, workspace[capability]);
          }
          await inspectStorageReleaseLogins(client);
          await qualification.query(`GRANT CONNECT ON DATABASE qualification_test TO ${names.runtime}`);
          await assert.rejects(inspectProvisionerWorkspaces(qualification, logins[0].role), /no validated schema/);
          await qualification.query(`REVOKE CONNECT ON DATABASE qualification_test FROM ${names.runtime}`);
          await qualification.query(`GRANT ${names.runtime} TO ${logins[0].role}`);
          await assert.rejects(inspectProvisionerWorkspaces(qualification, logins[0].role), /no validated schema/);
          await qualification.query(`REVOKE ${names.runtime} FROM ${logins[0].role}`);
          const unintended = await qualification.query(
            `SELECT 1 FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
        WHERE d.refclassid='pg_authid'::regclass AND d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND r.rolname=ANY($1::text[])`,
            [releaseLogins.map(login => login.role)],
          );
          assert.equal(unintended.rowCount, 0);
        },
      );
      await t.test(
        'ready isolated workspace permits replay while incomplete, orphaned, legacy and stream drift fail closed',
        async () => {
          await client.query(
            "INSERT INTO app.workspaces (id, request_id, created_by, name, slug, soul_commit, soul_bucket, soul_key, ready_at) VALUES ($1,$2,$3,'Ready','ready',repeat('a',40),'local','local',now())",
            [workspaceId, randomUUID(), userId],
          );
          await client.query(
            `INSERT INTO app.workspace_storage (workspace_id,initial_membership_id,stage,runtime_credential,migration_credential,confirmation_credential)
        VALUES ($1,$2,'ready',$3,$4,$5)`,
            [
              workspaceId,
              membershipId,
              ...['runtime', 'migration', 'confirmation'].map((capability, index) => {
                const credential = new URL(url);
                credential.username = names[capability];
                credential.password = password;
                return encryptCredential(
                  credential.href,
                  { workspaceId, generation: 1, capability },
                  { keyId: `${capability}-v1`, key: Buffer.alloc(32, index + 1) },
                );
              }),
            ],
          );
          await client.query(`UPDATE ${names.schema}.tf_soul_head SET revision=repeat('a',40) WHERE id=1`);
          assert.deepEqual(await checkStorageReleasePrerequisites(client, migrations), { credentialsExist: true });
          await configureStorageReleaseLogin(client, releaseLogins[0], password);
          assert.deepEqual(await checkStorageReleasePrerequisites(client, migrations), { credentialsExist: true });
          const retry = await runStorageRelease(
            { kind: 'logins', apply: true },
            {
              prerequisites: () => checkStorageReleasePrerequisites(client, migrations),
              inspectLogins: () => inspectStorageReleaseLogins(client),
              readSecret: async secret => {
                const login = releaseLogins.find(login => login.secret === secret);
                assert.ok(login);
                const credential = new URL(url);
                credential.username = login.role;
                credential.password = password;
                return credential.href;
              },
              loginPassword: (_login, value) => new URL(value).password,
              saveSecret: () => assert.fail('Retry must retain stored credentials'),
              configureLogin: (login, value) => configureStorageReleaseLogin(client, login, value),
              verifyLogin: async (_login, value) => {
                await open(value);
              },
            },
          );
          assert.deepEqual(
            retry.logins.map(login => login.action),
            ['reconcile', 'reconcile', 'reconcile', 'reconcile'],
          );
          await client.query("INSERT INTO app.workspace_memberships VALUES ($1,$2,'owner')", [workspaceId, userId]);
          await assert.rejects(checkStorageReleasePrerequisites(client, migrations), /reviewed targeted reset/);
          await client.query('DELETE FROM app.workspace_memberships');
          await client.query("UPDATE app.workspace_storage SET stage='database'");
          await assert.rejects(checkStorageReleasePrerequisites(client, migrations));
          await client.query("UPDATE app.workspace_storage SET stage='ready'");
          await client.query(`UPDATE ${names.schema}.tf_common_migrations SET checksum='drift' WHERE name=$1`, [
            common[0].name,
          ]);
          await assert.rejects(checkStorageReleasePrerequisites(client, migrations), /common stream/);
          await client.query(`UPDATE ${names.schema}.tf_common_migrations SET checksum=$1 WHERE name=$2`, [
            common[0].checksum,
            common[0].name,
          ]);
          await client.query('CREATE SCHEMA ws_orphan');
          await assert.rejects(checkStorageReleasePrerequisites(client, migrations), /ownership handoff/);
          await client.query('DROP SCHEMA ws_orphan');
          assert.deepEqual(await checkStorageReleasePrerequisites(client, migrations), { credentialsExist: true });
        },
      );
      await t.test(
        'retained tombstones preserve keys without requiring active readiness or a current common stream',
        async () => {
          await client.query(
            "UPDATE app.workspace_storage SET stage='unavailable',disabled_at=now(),disabled_operation_id=$2 WHERE workspace_id=$1",
            [workspaceId, randomUUID()],
          );
          await client.query(`DELETE FROM ${names.schema}.tf_common_migrations WHERE name=$1`, [common.at(-1).name]);
          await client.query(`UPDATE ${names.schema}.tf_soul_head SET revision=NULL WHERE id=1`);
          for (const phase of ['keys', 'activation'])
            assert.deepEqual(await checkStorageReleasePrerequisites(client, migrations, phase), {
              credentialsExist: true,
            });
          const incompleteId = randomUUID();
          await client.query(
            "INSERT INTO app.workspaces(id,request_id,created_by,name,slug) VALUES($1,$2,$3,'Incomplete','incomplete')",
            [incompleteId, randomUUID(), userId],
          );
          for (const phase of ['keys', 'activation'])
            await assert.rejects(checkStorageReleasePrerequisites(client, migrations, phase));
          await client.query('INSERT INTO app.workspace_storage(workspace_id) VALUES($1)', [incompleteId]);
          for (const phase of ['keys', 'activation'])
            await assert.rejects(checkStorageReleasePrerequisites(client, migrations, phase));
          await client.query(
            "UPDATE app.workspace_storage SET stage='unavailable',disabled_at=now(),disabled_operation_id=$2 WHERE workspace_id=$1",
            [incompleteId, randomUUID()],
          );
          for (const phase of ['keys', 'activation'])
            assert.deepEqual(await checkStorageReleasePrerequisites(client, migrations, phase), {
              credentialsExist: true,
            });
        },
      );
    } finally {
      await Promise.all(clients.map(client => client.end()));
      await exec('docker', ['rm', '--force', container]).catch(() => undefined);
    }
  },
);
import { provisionTestPgvector } from '../../../packages/workspace-storage/test/integration/pgvector.fixture.mjs';
