import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Client, escapeIdentifier } from 'pg';
import { createEmailLogin, encryptedProductKeyIds, inspectEmailLogin } from '../src/product-release-access.ts';
import { runProductRelease } from '../src/product-release.ts';
import { encryptInvitationCopy } from '../../../packages/workspaces/src/invitation-copy.ts';
import { verifyEmailDatabase } from '../email-readiness.mjs';

test(
  'real local PostgreSQL proves exact email grants, refusal, preservation, and cleanup',
  { timeout: 60000 },
  async t => {
    const adminUrl = new URL(
      process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres',
    );
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname), 'only a local server is permitted');
    assert.ok(['postgres:', 'postgresql:'].includes(adminUrl.protocol));
    assert.equal(adminUrl.search, '', 'local fixture URLs cannot override the connection target');
    assert.equal(adminUrl.hash, '');
    const suffix = randomUUID().replaceAll('-', '');
    const database = `product_release_${suffix}`;
    const role = `product_email_${suffix}`;
    const password = randomUUID() + randomUUID();
    const admin = new Client({ connectionString: adminUrl.href });
    const clients = [];
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${escapeIdentifier(database)}`);
      const url = new URL(adminUrl);
      url.pathname = `/${database}`;
      const client = new Client({ connectionString: url.href });
      await client.connect();
      clients.push(client);
      assert.deepEqual(await encryptedProductKeyIds(client), { email: [], integration: [] });
      await assert.rejects(inspectEmailLogin(client, role), /migration is required/);
      await client.query(`REVOKE ALL ON DATABASE ${escapeIdentifier(database)} FROM PUBLIC`);
      await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE SCHEMA app');
      await client.query('SET search_path = app, pg_catalog');
      await client.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const userId = randomUUID();
      await client.query(
        "INSERT INTO app.users (id,name,email,email_verified) VALUES ($1,'Preserved','preserved@example.test',true)",
        [userId],
      );
      await client.query(
        "INSERT INTO app.accounts (account_id,provider_id,user_id,updated_at) VALUES ('preserved','fixture',$1,now())",
        [userId],
      );
      await client.query(
        "INSERT INTO app.sessions (expires_at,token,updated_at,user_id) VALUES (now()+interval '1 hour','preserved-session',now(),$1)",
        [userId],
      );
      await client.query(
        "INSERT INTO app.verifications (identifier,value,expires_at) VALUES ('preserved','preserved',now()+interval '1 hour')",
      );
      const identities = new Map();
      for (const table of ['users', 'accounts', 'sessions', 'verifications'])
        identities.set(table, (await client.query(`SELECT * FROM app.${table}`)).rows);
      await client.query(`CREATE TABLE app.protected_identity (id text PRIMARY KEY, value jsonb);
      INSERT INTO app.protected_identity VALUES ('identity', '{"accounts":2,"sessions":2,"billing":"unchanged"}');
      CREATE TABLE app.protected_global (id integer PRIMARY KEY, value text);
      INSERT INTO app.protected_global VALUES (1,'unchanged')`);
      const protectedBefore = (await client.query('SELECT * FROM app.protected_identity')).rows;
      const globalBefore = (await client.query('SELECT * FROM app.protected_global')).rows;
      assert.deepEqual(await encryptedProductKeyIds(client), { email: [], integration: [] });
      await client.query(
        `INSERT INTO app.email_deliveries (id,kind,payload,expires_at) VALUES ($1,'magic-link',$2,now()+interval '1 hour')`,
        [randomUUID(), { keyId: 'email-v1', ciphertext: 'opaque' }],
      );
      assert.deepEqual(await encryptedProductKeyIds(client), { email: ['email-v1'], integration: [] });
      const schema = `ws_${suffix}`;
      await client.query(
        `CREATE SCHEMA ${escapeIdentifier(schema)}; CREATE TABLE ${escapeIdentifier(schema)}.tf_integrations (credential jsonb)`,
      );
      await client.query(
        `INSERT INTO ${escapeIdentifier(schema)}.tf_integrations VALUES ('{"keyId":"integration-old","ciphertext":"opaque"}')`,
      );
      assert.deepEqual(await encryptedProductKeyIds(client), { email: ['email-v1'], integration: ['integration-old'] });
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE ${escapeIdentifier(schema)}.tf_integrations SET credential='{"ciphertext":"missing-key-id"}'`,
        );
        await assert.rejects(encryptedProductKeyIds(client));
      } finally {
        await client.query('ROLLBACK');
      }

      await t.test(
        'copy-only invitation key references block planning until the previous key is retained',
        async () => {
          await client.query('BEGIN');
          try {
            await client.query('DELETE FROM app.email_deliveries');
            await client.query(`DELETE FROM ${escapeIdentifier(schema)}.tf_integrations`);
            await client.query(`CREATE TABLE ${escapeIdentifier(schema)}.tf_invitations (copy_material jsonb)`);
            const envelope = encryptInvitationCopy(
              randomUUID(),
              randomUUID(),
              'https://app.example.test/invite?token=fixture',
              { keyId: 'invitation-old', key: Buffer.from('c'.repeat(64), 'hex'), previous: new Map() },
            );
            await client.query(`INSERT INTO ${escapeIdentifier(schema)}.tf_invitations VALUES ($1), (NULL)`, [
              envelope,
            ]);
            const secrets = new Map([
              ['email-delivery-key', 'a'.repeat(64)],
              ['email-delivery-key-id', 'email-v1'],
              ['email-delivery-previous-keys', '{}'],
              ['integration-credential-key', 'b'.repeat(64)],
              ['integration-credential-key-id', 'connection-v1'],
              ['integration-credential-previous-keys', '{}'],
            ]);
            const ports = {
              encryptedKeyIds: () => encryptedProductKeyIds(client),
              readSecret: async name => secrets.get(name),
              createSecret: async () => assert.fail('planning must not write secrets'),
              randomHex: () => assert.fail('planning must not generate keys'),
            };
            await assert.rejects(runProductRelease({ kind: 'keys', apply: false }, ports), /unavailable key ID/);
            assert.deepEqual(await encryptedProductKeyIds(client), { email: ['invitation-old'], integration: [] });
            secrets.set('email-delivery-previous-keys', JSON.stringify({ 'invitation-old': 'c'.repeat(64) }));
            const before = [...secrets];
            const plan = await runProductRelease({ kind: 'keys', apply: false }, ports);
            assert.deepEqual(
              plan.keys.map(key => [key.keyId, key.action]),
              [
                ['email-v1', 'retain'],
                ['connection-v1', 'retain'],
              ],
            );
            assert.deepEqual([...secrets], before);
            for (const malformed of [{ ciphertext: 'missing-key-id' }, { keyId: '' }, null, 'not-an-envelope']) {
              await client.query(`UPDATE ${escapeIdentifier(schema)}.tf_invitations SET copy_material=$1`, [
                JSON.stringify(malformed),
              ]);
              await assert.rejects(runProductRelease({ kind: 'keys', apply: false }, ports), { name: 'ZodError' });
            }
          } finally {
            await client.query('ROLLBACK');
          }
        },
      );
      await t.test('invitation discovery supports pre-0015 columns and ignores non-workspace schemas', async () => {
        await client.query('BEGIN');
        try {
          await client.query(`CREATE TABLE ${escapeIdentifier(schema)}.tf_invitations (id uuid)`);
          const outside = `${schema}_"; SELECT 1; --`;
          await client.query(`CREATE SCHEMA ${escapeIdentifier(outside)}`);
          await client.query(`CREATE TABLE ${escapeIdentifier(outside)}.tf_invitations (copy_material jsonb)`);
          await client.query(`INSERT INTO ${escapeIdentifier(outside)}.tf_invitations VALUES ('{}')`);
          assert.deepEqual(await encryptedProductKeyIds(client), {
            email: ['email-v1'],
            integration: ['integration-old'],
          });
          await client.query(`ALTER TABLE ${escapeIdentifier(schema)}.tf_invitations ADD COLUMN copy_material jsonb`);
          await client.query(
            `INSERT INTO ${escapeIdentifier(schema)}.tf_invitations VALUES (NULL, '{"keyId":"invitation-old"}')`,
          );
          const inventory = await encryptedProductKeyIds(client);
          assert.deepEqual(inventory.email.sort(), ['email-v1', 'invitation-old']);
          assert.deepEqual(inventory.integration, ['integration-old']);
          await client.query(`ALTER TABLE ${escapeIdentifier(schema)}.tf_invitations DROP COLUMN copy_material`);
          assert.deepEqual(await encryptedProductKeyIds(client), {
            email: ['email-v1'],
            integration: ['integration-old'],
          });
          await client.query(`ALTER TABLE ${escapeIdentifier(schema)}.tf_invitations ADD COLUMN copy_material text`);
          await assert.rejects(encryptedProductKeyIds(client), { code: '42883' });
        } finally {
          await client.query('ROLLBACK');
        }
      });

      await t.test('unmarked and elevated preexisting roles cannot be adopted', async () => {
        for (const attributes of ['NOLOGIN', 'LOGIN SUPERUSER']) {
          await client.query(`CREATE ROLE ${escapeIdentifier(role)} ${attributes}`);
          await assert.rejects(createEmailLogin(client, password, role), /Unexpected or elevated/);
          await client.query(`DROP ROLE ${escapeIdentifier(role)}`);
        }
      });
      await t.test('non-superuser creation retains only the automatic creator administration grant', async () => {
        const creator = `email_creator_${suffix}`;
        await client.query(`CREATE ROLE ${escapeIdentifier(creator)} CREATEROLE NOLOGIN`);
        try {
          await client.query(
            `GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(creator)} WITH GRANT OPTION`,
          );
          await client.query(`GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(creator)} WITH GRANT OPTION`);
          await client.query(
            `GRANT SELECT, UPDATE ON app.email_deliveries TO ${escapeIdentifier(creator)} WITH GRANT OPTION`,
          );
          await client.query(`SET ROLE ${escapeIdentifier(creator)}`);
          await createEmailLogin(client, password, role);
          assert.equal(await inspectEmailLogin(client, role), 'retained');
          assert.deepEqual(
            (
              await client.query(
                `SELECT admin_option, inherit_option, set_option FROM pg_auth_members
          WHERE roleid=$1::regrole AND member=current_user::regrole`,
                [role],
              )
            ).rows,
            [{ admin_option: true, inherit_option: false, set_option: false }],
          );
        } finally {
          await client.query('RESET ROLE');
          await client.query(`DROP OWNED BY ${escapeIdentifier(creator)} CASCADE`);
          if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
            await client.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
            await client.query(`DROP ROLE ${escapeIdentifier(role)}`);
          }
          await client.query(`DROP ROLE ${escapeIdentifier(creator)}`);
        }
      });
      await createEmailLogin(client, password, role);
      assert.equal(await inspectEmailLogin(client, role), 'retained');
      const hash = (await client.query('SELECT rolpassword FROM pg_authid WHERE rolname=$1', [role])).rows[0]
        .rolpassword;
      await assert.rejects(createEmailLogin(client, 'replacement-password-must-not-apply', role), /already exists/);
      assert.equal(
        (await client.query('SELECT rolpassword FROM pg_authid WHERE rolname=$1', [role])).rows[0].rolpassword,
        hash,
      );
      url.username = role;
      url.password = password;
      const scoped = new Client({ connectionString: url.href });
      await scoped.connect();
      clients.push(scoped);
      await verifyEmailDatabase(scoped, role);
      await client.query(`GRANT SELECT ON app.users TO ${escapeIdentifier(role)}`);
      await assert.rejects(verifyEmailDatabase(scoped, role), /Invalid email login privileges/);
      await client.query(`REVOKE SELECT ON app.users FROM ${escapeIdentifier(role)}`);
      await verifyEmailDatabase(scoped, role);
      assert.equal((await scoped.query('SELECT current_user')).rows[0].current_user, role);
      assert.equal((await scoped.query('SELECT * FROM app.email_deliveries')).rowCount, 1);
      assert.equal(
        (await scoped.query('UPDATE app.email_deliveries SET attempts=attempts+1 RETURNING attempts')).rows[0].attempts,
        1,
      );
      for (const sql of [
        'SELECT * FROM app.protected_identity',
        'SELECT * FROM app.users',
        'SELECT * FROM app.accounts',
        'SELECT * FROM app.sessions',
        'SELECT * FROM app.verifications',
        "UPDATE app.protected_global SET value='changed'",
        'DELETE FROM app.email_deliveries',
        'TRUNCATE app.email_deliveries',
        'INSERT INTO app.email_deliveries SELECT * FROM app.email_deliveries',
        'CREATE TABLE app.forbidden (id integer)',
        'CREATE TEMP TABLE forbidden (id integer)',
        "SELECT app.invitation_delivery(gen_random_uuid(),gen_random_uuid(),'status')",
      ])
        await assert.rejects(scoped.query(sql), { code: '42501' });
      const grants = (
        await client.query(
          `SELECT privilege_type,is_grantable FROM information_schema.role_table_grants
      WHERE grantee=$1 AND table_schema='app' ORDER BY privilege_type`,
          [role],
        )
      ).rows;
      assert.deepEqual(grants, [
        { privilege_type: 'SELECT', is_grantable: 'NO' },
        { privilege_type: 'UPDATE', is_grantable: 'NO' },
      ]);
      await t.test('extra columns, grant options, memberships, defaults, and role elevation are rejected', async () => {
        for (const sql of [
          `GRANT SELECT (value) ON app.protected_identity TO ${escapeIdentifier(role)}`,
          `GRANT UPDATE ON app.email_deliveries TO ${escapeIdentifier(role)} WITH GRANT OPTION`,
          `GRANT pg_read_all_data TO ${escapeIdentifier(role)}`,
          `GRANT ALTER SYSTEM ON PARAMETER log_statement TO ${escapeIdentifier(role)}`,
          'GRANT ALTER SYSTEM ON PARAMETER log_statement TO PUBLIC',
          `ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${escapeIdentifier(role)}`,
          `ALTER ROLE ${escapeIdentifier(role)} BYPASSRLS`,
          `GRANT SELECT ON app.protected_identity TO PUBLIC`,
        ]) {
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await assert.rejects(inspectEmailLogin(client, role), /unexpected|elevated/);
          } finally {
            await client.query('ROLLBACK');
          }
        }
      });
      assert.deepEqual((await client.query('SELECT * FROM app.protected_identity')).rows, protectedBefore);
      assert.deepEqual((await client.query('SELECT * FROM app.protected_global')).rows, globalBefore);
      for (const [table, before] of identities)
        assert.deepEqual((await client.query(`SELECT * FROM app.${table}`)).rows, before);
    } finally {
      await Promise.all(clients.map(client => client.end()));
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0);
      assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount, 0);
      await admin.end();
    }
  },
);
