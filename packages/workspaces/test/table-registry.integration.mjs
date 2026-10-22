import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool, escapeIdentifier } from 'pg';
import { provisionTableRegistry } from '../src/table-registry.ts';
import {
  fixture,
  connect,
  denied,
  loadPlatformBaseline,
  markWorkspaceReady,
} from '../../workspace-storage/test/integration/fixture.mjs';
import { encryptCredential } from '../src/credentials.ts';
import { createConfirmationCredentialResolver } from '../src/capabilities.ts';

async function registryFixture(run) {
  const setup = await fixture();
  const roles = [];
  try {
    await loadPlatformBaseline(setup.platform);
    for (const capability of ['authoring', 'confirmation', 'migration']) {
      const input = {
        capability,
        role: `registry_${randomUUID().replaceAll('-', '')}`,
        password: randomBytes(32).toString('hex'),
      };
      await provisionTableRegistry(setup.platform, input);
      roles.push(input.role);
      const url = new URL(setup.connectionString);
      url.username = input.role;
      url.password = input.password;
      const client = await connect(url.href);
      try {
        await run({ setup, input, client });
      } finally {
        await client.end();
      }
    }
  } finally {
    try {
      for (const role of roles) {
        await setup.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
        await setup.admin.query(`DROP ROLE ${escapeIdentifier(role)}`);
      }
    } finally {
      await setup.close();
    }
  }
}

test('repeat registry provisioning removes global and schema creator defaults before future objects exist', async () => {
  await registryFixture(async ({ setup, input, client }) => {
    for (const scope of ['', 'IN SCHEMA app']) {
      for (const objects of ['TABLES', 'SEQUENCES', 'ROUTINES']) {
        await setup.platform.query(
          `ALTER DEFAULT PRIVILEGES ${scope} GRANT ALL ON ${objects} TO ${escapeIdentifier(input.role)}, PUBLIC`,
        );
      }
    }
    await provisionTableRegistry(setup.platform, input);
    await provisionTableRegistry(setup.platform, input);
    const table = `app.future_${input.capability}`;
    await setup.platform
      .query(`CREATE TABLE ${table} (id serial, secret text); INSERT INTO ${table} (secret) VALUES ('private');
      CREATE FUNCTION app.future_${input.capability}() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT secret FROM ${table} LIMIT 1'`);
    await denied(client, `SELECT secret FROM ${table}`);
    await denied(client, `SELECT last_value FROM ${table}_id_seq`);
    await denied(client, `SELECT nextval('${table}_id_seq')`);
    await denied(client, `SELECT app.future_${input.capability}()`);
    const credential = input.capability === 'authoring' ? 'runtime_credential' : `${input.capability}_credential`;
    await client.query(`SELECT workspace_id, generation, stage, ${credential} FROM app.workspace_storage`);
    await denied(client, `SET ROLE ${escapeIdentifier(setup.owner)}`);
  });
});

test('registry provisioning rejects effective PUBLIC table, column, sequence and routine privileges', async () => {
  await registryFixture(async ({ setup, input, client }) => {
    await setup.platform.query(`CREATE SEQUENCE app.public_sequence_${input.capability};
      CREATE FUNCTION app.public_routine_${input.capability}() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT email FROM app.users LIMIT 1';
      REVOKE ALL ON FUNCTION app.public_routine_${input.capability}() FROM PUBLIC`);
    const otherCredential = input.capability === 'migration' ? 'confirmation_credential' : 'migration_credential';
    for (const [grant, revoke, probe] of [
      ['SELECT ON app.users', 'ALL ON app.users', 'SELECT email FROM app.users'],
      ['SELECT (email) ON app.users', 'ALL (email) ON app.users', 'SELECT email FROM app.users'],
      [
        'UPDATE (generation) ON app.workspace_storage',
        'ALL (generation) ON app.workspace_storage',
        'UPDATE app.workspace_storage SET generation = 2',
      ],
      [
        `SELECT (${otherCredential}) ON app.workspace_storage`,
        `ALL (${otherCredential}) ON app.workspace_storage`,
        `SELECT ${otherCredential} FROM app.workspace_storage`,
      ],
      [
        `USAGE ON SEQUENCE app.public_sequence_${input.capability}`,
        `ALL ON SEQUENCE app.public_sequence_${input.capability}`,
        `SELECT nextval('app.public_sequence_${input.capability}')`,
      ],
      [
        `EXECUTE ON FUNCTION app.public_routine_${input.capability}()`,
        `ALL ON FUNCTION app.public_routine_${input.capability}()`,
        `SELECT app.public_routine_${input.capability}()`,
      ],
    ]) {
      await setup.platform.query(`GRANT ${grant} TO PUBLIC`);
      await assert.rejects(provisionTableRegistry(setup.platform, input), /ambient privileges/);
      await setup.platform.query(`REVOKE ${revoke} FROM PUBLIC`);
      await provisionTableRegistry(setup.platform, input);
      await denied(client, probe);
    }
    await setup.platform.query(`GRANT SELECT (workspace_id) ON app.workspace_storage TO PUBLIC`);
    await provisionTableRegistry(setup.platform, input);
    await client.query('SELECT workspace_id FROM app.workspace_storage');
    await setup.platform.query('REVOKE ALL (workspace_id) ON app.workspace_storage FROM PUBLIC');
    await setup.platform.query(
      `GRANT EXECUTE ON FUNCTION app.public_routine_${input.capability}() TO ${escapeIdentifier(input.role)}`,
    );
    await provisionTableRegistry(setup.platform, input);
    await denied(client, `SELECT app.public_routine_${input.capability}()`);
  });
});

test('registry provisioning fails closed on default grants from an unsupported creator', async () => {
  await registryFixture(async ({ setup, input }) => {
    const creator = `creator_${randomUUID().replaceAll('-', '')}`;
    await setup.admin.query(`CREATE ROLE ${escapeIdentifier(creator)} NOLOGIN`);
    try {
      for (const recipient of [escapeIdentifier(input.role), 'PUBLIC']) {
        await setup.databaseAdmin.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} IN SCHEMA app GRANT SELECT ON TABLES TO ${recipient}`,
        );
        await assert.rejects(
          provisionTableRegistry(setup.platform, input),
          /Cannot repair registry default privileges/,
        );
        await setup.databaseAdmin.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} IN SCHEMA app REVOKE ALL ON TABLES FROM ${recipient}`,
        );
      }
      await provisionTableRegistry(setup.platform, input);
    } finally {
      await setup.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(creator)}`);
      await setup.admin.query(`DROP ROLE ${escapeIdentifier(creator)}`);
    }
  });
});

test('registry provisioning repairs another supported creator without granting registry membership', async () => {
  await registryFixture(async ({ setup, input, client }) => {
    const creator = `creator_${randomUUID().replaceAll('-', '')}`;
    await setup.platform.query(`CREATE ROLE ${escapeIdentifier(creator)} NOLOGIN`);
    try {
      await setup.platform
        .query(`GRANT ${escapeIdentifier(creator)} TO ${escapeIdentifier(setup.owner)} WITH INHERIT TRUE, SET TRUE;
        GRANT CREATE, USAGE ON SCHEMA app TO ${escapeIdentifier(creator)};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} IN SCHEMA app GRANT SELECT ON TABLES TO ${escapeIdentifier(input.role)}`);
      await provisionTableRegistry(setup.platform, input);
      await setup.platform.query(`SET ROLE ${escapeIdentifier(creator)}`);
      try {
        await setup.platform.query(`CREATE TABLE app.other_${input.capability} (secret text);
          CREATE FUNCTION app.other_${input.capability}() RETURNS text LANGUAGE sql AS 'SELECT ''private''::text'`);
      } finally {
        await setup.platform.query('RESET ROLE');
      }
      await denied(client, `SELECT secret FROM app.other_${input.capability}`);
      await denied(client, `SELECT app.other_${input.capability}()`);
      await denied(client, `SET ROLE ${escapeIdentifier(creator)}`);
    } finally {
      await setup.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(creator)}`);
      await setup.admin.query(`DROP ROLE ${escapeIdentifier(creator)}`);
    }
  });
});

test('registry CLI accepts canonical scoped credentials and rejects endpoint or identity overrides', async () => {
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../../../apps/database/src/table-registry.ts', import.meta.url));
  await registryFixture(async ({ setup, input }) => {
    const variable =
      input.capability === 'authoring'
        ? 'WORKSPACE_AUTHORING_DATABASE_URL'
        : `WORKSPACE_${input.capability.toUpperCase()}_REGISTRY_DATABASE_URL`;
    const target = new URL(setup.connectionString);
    target.username = input.role;
    target.password = input.password;
    const env = {
      ...process.env,
      WORKSPACE_PROVISIONING_DATABASE_URL: setup.connectionString,
      [variable]: target.href,
    };
    const result = await execute(process.execPath, [cli, input.capability], { env });
    assert.deepEqual(JSON.parse(result.stdout), { capability: input.capability, status: 'provisioned' });
    for (const overrides of [
      { [variable]: `${target.href}?user=${setup.owner}` },
      { [variable]: `${target.href}?host=other.invalid` },
      { [variable]: `${target.href}?options=-c%20role%3D${setup.owner}` },
      { [variable]: `${target.href}#ignored` },
      { [variable]: setup.connectionString },
      { WORKSPACE_PROVISIONING_DATABASE_URL: `${setup.connectionString}?dbname=postgres` },
    ]) {
      await assert.rejects(
        execute(process.execPath, [cli, input.capability], { env: { ...env, ...overrides } }),
        error => {
          assert.equal(error.code, 1);
          assert.equal(error.stdout, '');
          assert.match(error.stderr, /^Table registry provisioning failed\./);
          assert.equal(error.stderr.includes(input.password), false);
          return true;
        },
      );
    }
  });
});

test('registry logins expose only their capability ciphertext and replay repairs column grants', async () => {
  const setup = await fixture();
  const roles = [];
  const keys = { runtime: randomBytes(32), migration: randomBytes(32), confirmation: randomBytes(32) };
  const oldKey = process.env.WORKSPACE_CONFIRMATION_KEY;
  const oldId = process.env.WORKSPACE_CONFIRMATION_KEY_ID;
  try {
    await loadPlatformBaseline(setup.platform);
    const workspace = await setup.create();
    const credentials = ['runtime', 'migration', 'confirmation'].map(capability =>
      encryptCredential(
        setup.login(workspace, capability),
        { workspaceId: workspace.id, generation: 1, capability },
        { key: keys[capability], keyId: 'test-v1' },
      ),
    );
    await markWorkspaceReady(setup.platform, workspace.id);
    await setup.platform.query(
      'UPDATE app.workspace_storage SET runtime_credential = $2, migration_credential = $3, confirmation_credential = $4 WHERE workspace_id = $1',
      [workspace.id, ...credentials],
    );
    for (const capability of ['authoring', 'confirmation', 'migration']) {
      const role = `registry_${randomUUID().replaceAll('-', '')}`;
      const password = randomBytes(32).toString('hex');
      await provisionTableRegistry(setup.platform, { capability, role, password });
      roles.push(role);
      const url = new URL(setup.connectionString);
      url.username = role;
      url.password = password;
      const client = await connect(url.href);
      const column = capability === 'authoring' ? 'runtime_credential' : `${capability}_credential`;
      try {
        assert.equal(
          (await client.query(`SELECT workspace_id, generation, stage, ${column} FROM app.workspace_storage`)).rowCount,
          1,
        );
        for (const secret of ['runtime_credential', 'migration_credential', 'confirmation_credential'].filter(
          value => value !== column,
        )) {
          await denied(client, `SELECT ${secret} FROM app.workspace_storage`);
        }
        await denied(client, 'SELECT * FROM app.accounts');
        await denied(client, 'SELECT name FROM app.workspaces');
        await denied(client, 'UPDATE app.workspace_storage SET generation = 2');
        await denied(client, `SELECT * FROM "${workspace.names.schema}".tf_memberships`);
        await denied(client, `SET ROLE "${workspace.names.customOwner}"`);
        if (capability === 'confirmation') {
          process.env.WORKSPACE_CONFIRMATION_KEY = keys.confirmation.toString('hex');
          process.env.WORKSPACE_CONFIRMATION_KEY_ID = 'test-v1';
          const pool = new Pool({ connectionString: url.href });
          try {
            assert.equal(
              (await createConfirmationCredentialResolver(pool)(workspace.id)).connectionString,
              setup.login(workspace, 'confirmation'),
            );
          } finally {
            await pool.end();
          }
        }
      } finally {
        await client.end();
      }
      await setup.platform.query(`GRANT SELECT (name) ON app.workspaces TO ${escapeIdentifier(role)}`);
      await provisionTableRegistry(setup.platform, { capability, role, password });
      const repaired = await connect(url.href);
      try {
        await denied(repaired, 'SELECT name FROM app.workspaces');
      } finally {
        await repaired.end();
      }
    }
  } finally {
    if (oldKey === undefined) delete process.env.WORKSPACE_CONFIRMATION_KEY;
    else process.env.WORKSPACE_CONFIRMATION_KEY = oldKey;
    if (oldId === undefined) delete process.env.WORKSPACE_CONFIRMATION_KEY_ID;
    else process.env.WORKSPACE_CONFIRMATION_KEY_ID = oldId;
    try {
      for (const role of roles) {
        await setup.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
        await setup.admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      }
    } finally {
      await setup.close();
    }
  }
});
