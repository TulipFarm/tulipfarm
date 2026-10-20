import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expireOnboarding, resumeOnboarding, saveOnboarding } from '@tulipfarm/workspaces/onboarding';
import { bootstrap, connect } from '../../src/postgres.ts';
import { migrate } from '../../src/migrations.ts';

const exec = promisify(execFile);
const passwords = {
  owner: 'disposable-owner-only',
  application: 'disposable-identity-only',
  temporal: 'disposable-temporal-only',
};

async function startPostgres(container) {
  await exec('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '-e',
    'POSTGRES_PASSWORD=disposable-admin-only',
    '-p',
    '127.0.0.1::5432',
    'postgres:18.3',
  ]);
  const { stdout } = await exec('docker', ['port', container, '5432/tcp']);
  const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
  assert.ok(port, 'Disposable PostgreSQL must bind only to loopback');
  for (let attempt = 0; ; attempt++) {
    try {
      await exec('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      return port;
    } catch (error) {
      if (attempt === 60) throw error;
      await setTimeout(250);
    }
  }
}

test('bootstrap reruns preserve isolated registry grants and identity CRUD', { timeout: 90000 }, async () => {
  const container = `platform-grants-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'platform-grants-'));
  const clients = [];
  const previousCapability = process.env.WORKSPACE_STORAGE_CAPABILITY;
  try {
    const port = await startPostgres(container);
    const adminUrl = `postgresql://postgres:disposable-admin-only@127.0.0.1:${port}/postgres`;
    process.env.WORKSPACE_STORAGE_CAPABILITY = 'disabled';
    await bootstrap(adminUrl, passwords);
    const owner = await connect(`postgresql://tulipfarm_owner:${passwords.owner}@127.0.0.1:${port}/tulipfarm`);
    clients.push(owner);
    const administrator = await connect(`postgresql://postgres:disposable-admin-only@127.0.0.1:${port}/tulipfarm`);
    clients.push(administrator);
    const migrations = new URL('../../migrations/', import.meta.url);
    for (const name of ['0001_baseline.sql']) {
      await writeFile(join(directory, name), await readFile(new URL(name, migrations), 'utf8'));
    }
    await migrate(owner, directory);
    const identity = await connect(`postgresql://tulipfarm:${passwords.application}@127.0.0.1:${port}/tulipfarm`);
    clients.push(identity);
    await identity.query(
      "INSERT INTO app.users (id, name, email, email_verified) VALUES ($1, 'Before cutover', 'before@example.test', false)",
      ['11111111-1111-4111-8111-111111111111'],
    );
    await identity.query(
      "INSERT INTO app.workspaces (id, request_id, created_by, name, slug) VALUES ($1, $2, $3, 'Legacy', 'legacy')",
      ['22222222-2222-4222-8222-222222222222', randomUUID(), '11111111-1111-4111-8111-111111111111'],
    );
    await identity.query("INSERT INTO app.workspace_memberships VALUES ($1, $2, 'owner')", [
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ]);
    for (const capability of [undefined, '', 'disabled']) {
      if (capability === undefined) delete process.env.WORKSPACE_STORAGE_CAPABILITY;
      else process.env.WORKSPACE_STORAGE_CAPABILITY = capability;
      await bootstrap(adminUrl, passwords);
      await migrate(owner, directory);
      assert.equal((await owner.query('SELECT * FROM database_management.storage_capabilities')).rowCount, 0);
      assert.equal(
        (await identity.query("UPDATE app.workspaces SET name = 'Legacy retained' RETURNING name")).rowCount,
        1,
      );
    }
    assert.equal(
      (await identity.query("UPDATE app.workspaces SET name = 'Legacy retained' RETURNING name")).rows[0].name,
      'Legacy retained',
    );
    assert.equal(
      (
        await identity.query(
          "UPDATE app.workspaces SET ready_at = now(), soul_commit = repeat('a', 40), soul_bucket = 'legacy', soul_key = 'legacy' RETURNING soul_commit",
        )
      ).rows[0].soul_commit,
      'a'.repeat(40),
    );

    await assert.rejects(identity.query('SELECT migration_credential FROM app.workspace_storage'), { code: '42501' });
    await bootstrap(adminUrl, passwords);
    await assert.rejects(identity.query('SELECT confirmation_credential FROM app.workspace_storage'), {
      code: '42501',
    });
    assert.equal(
      (await identity.query("UPDATE app.workspaces SET name = 'Still legacy' RETURNING name")).rows[0].name,
      'Still legacy',
    );

    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO tulipfarm;
      ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tulipfarm;
      ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO tulipfarm;
      ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tulipfarm;
      ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO tulipfarm;
      CREATE TABLE app.unlisted_before_bootstrap (id integer);
      CREATE SEQUENCE app.unlisted_sequence_before_bootstrap`);
    await administrator.query(`CREATE ROLE other_creator;
      GRANT other_creator TO tulipfarm_owner;
      GRANT USAGE, CREATE ON SCHEMA app TO other_creator`);
    for (const creator of ['postgres', 'other_creator']) {
      for (const scope of ['', 'IN SCHEMA app']) {
        await administrator.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${creator} ${scope} GRANT SELECT ON TABLES TO tulipfarm;
          ALTER DEFAULT PRIVILEGES FOR ROLE ${creator} ${scope} GRANT USAGE, SELECT ON SEQUENCES TO tulipfarm`);
      }
    }
    process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';
    await bootstrap(adminUrl, passwords);
    await bootstrap(adminUrl, passwords);
    await migrate(owner, directory);
    const marker = (await owner.query('SELECT * FROM database_management.storage_capabilities')).rows;
    assert.equal(marker.length, 1);
    assert.equal(marker[0].capability, 'isolated-v1');
    for (const sql of [
      'DELETE FROM database_management.storage_capabilities',
      "UPDATE database_management.storage_capabilities SET capability = 'isolated-v1'",
      'DROP TABLE database_management.storage_capabilities',
    ]) {
      await assert.rejects(identity.query(sql), { code: '42501' });
    }

    for (const creator of ['postgres', 'other_creator']) {
      await administrator.query(`SET ROLE ${creator}`);
      await administrator.query(
        `CREATE TABLE app.other_creator_table (id integer); CREATE SEQUENCE app.other_creator_sequence`,
      );
      await assert.rejects(identity.query('SELECT * FROM app.other_creator_table'), { code: '42501' });
      await assert.rejects(identity.query("SELECT nextval('app.other_creator_sequence')"), { code: '42501' });
      await administrator.query(
        'DROP TABLE app.other_creator_table; DROP SEQUENCE app.other_creator_sequence; RESET ROLE',
      );
    }

    for (const capability of [undefined, '', 'disabled']) {
      if (capability === undefined) delete process.env.WORKSPACE_STORAGE_CAPABILITY;
      else process.env.WORKSPACE_STORAGE_CAPABILITY = capability;
      for (const rerun of [() => bootstrap(adminUrl, passwords), () => migrate(owner, directory)]) {
        await rerun();
        await assert.rejects(
          identity.query("UPDATE app.workspaces SET ready_at = now(), soul_commit = repeat('b', 40)"),
          { code: '42501' },
        );
        await assert.rejects(
          identity.query("INSERT INTO app.workspace_memberships VALUES ($1, $2, 'owner')", [
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
          ]),
          { code: '42501' },
        );
        await assert.rejects(
          identity.query('SELECT migration_credential, confirmation_credential FROM app.workspace_storage'),
          { code: '42501' },
        );
      }
    }
    assert.deepEqual((await owner.query('SELECT * FROM database_management.storage_capabilities')).rows, marker);
    await writeFile(join(directory, '0005_probe.sql'), 'CREATE TABLE app.later_migration (id integer);');
    await migrate(owner, directory);
    await assert.rejects(identity.query('UPDATE app.workspaces SET ready_at = now()'), { code: '42501' });
    await assert.rejects(identity.query('SELECT * FROM app.later_migration'), { code: '42501' });

    for (const scope of ['', 'IN SCHEMA app']) {
      await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE other_creator ${scope} GRANT SELECT ON TABLES TO tulipfarm;
        ALTER DEFAULT PRIVILEGES FOR ROLE other_creator ${scope} GRANT USAGE, SELECT ON SEQUENCES TO tulipfarm`);
      await migrate(owner, directory);
      await administrator.query(
        'SET ROLE other_creator; CREATE TABLE app.member_future (id integer); CREATE SEQUENCE app.member_future_seq',
      );
      await assert.rejects(identity.query('SELECT * FROM app.member_future'), { code: '42501' });
      await assert.rejects(identity.query("SELECT nextval('app.member_future_seq')"), { code: '42501' });
      await administrator.query('DROP TABLE app.member_future; DROP SEQUENCE app.member_future_seq; RESET ROLE');

      await administrator.query(`ALTER DEFAULT PRIVILEGES ${scope} GRANT SELECT ON TABLES TO tulipfarm;
        ALTER DEFAULT PRIVILEGES ${scope} GRANT USAGE, SELECT ON SEQUENCES TO tulipfarm`);
      const receipts = (await owner.query('SELECT * FROM database_management.migrations ORDER BY name')).rows;
      await assert.rejects(
        migrate(owner, directory),
        /Cannot repair application default privileges for creator postgres/,
      );
      assert.deepEqual(
        (await owner.query('SELECT * FROM database_management.migrations ORDER BY name')).rows,
        receipts,
      );
      assert.deepEqual((await owner.query('SELECT * FROM database_management.storage_capabilities')).rows, marker);
      await assert.rejects(identity.query('UPDATE app.workspaces SET ready_at = now()'), { code: '42501' });
      await bootstrap(adminUrl, passwords);
      await administrator.query('CREATE TABLE app.admin_future (id integer); CREATE SEQUENCE app.admin_future_seq');
      await assert.rejects(identity.query('SELECT * FROM app.admin_future'), { code: '42501' });
      await assert.rejects(identity.query("SELECT nextval('app.admin_future_seq')"), { code: '42501' });
      await administrator.query('DROP TABLE app.admin_future; DROP SEQUENCE app.admin_future_seq');
      await migrate(owner, directory);
    }

    for (const column of ['migration_credential', 'confirmation_credential', 'initial_membership_id']) {
      await assert.rejects(
        identity.query(`SELECT ${column} FROM app.workspace_storage`),
        { code: '42501' },
        `${column} must remain private after bootstrap reruns`,
      );
    }
    for (const assignment of [
      "stage = 'ready'",
      'generation = 2',
      "runtime_credential = '{}'::jsonb",
      'error_code = NULL',
      'updated_at = now()',
    ]) {
      await assert.rejects(identity.query(`UPDATE app.workspace_storage SET ${assignment}`), { code: '42501' });
    }
    await assert.rejects(identity.query('UPDATE app.workspaces SET ready_at = now()'), { code: '42501' });
    await assert.rejects(identity.query("UPDATE app.workspaces SET soul_commit = repeat('a', 40)"), { code: '42501' });
    await assert.rejects(identity.query('SELECT * FROM app.workspace_memberships'), { code: '42501' });
    await assert.rejects(identity.query('DELETE FROM app.workspace_storage'), { code: '42501' });
    await owner.query(
      'CREATE TABLE app.unlisted_after_bootstrap (id integer); CREATE SEQUENCE app.unlisted_sequence_after_bootstrap',
    );
    for (const suffix of ['before_bootstrap', 'after_bootstrap']) {
      await assert.rejects(identity.query(`SELECT * FROM app.unlisted_${suffix}`), { code: '42501' });
      await assert.rejects(identity.query(`SELECT nextval('app.unlisted_sequence_${suffix}')`), { code: '42501' });
    }
    await owner.query(
      'ALTER TABLE app.workspace_storage ADD COLUMN future_private text; ALTER TABLE app.workspaces ADD COLUMN future_private text',
    );
    await bootstrap(adminUrl, passwords);
    await assert.rejects(identity.query('SELECT * FROM app.unlisted_after_bootstrap'), { code: '42501' });
    for (const table of ['workspace_storage', 'workspaces'])
      await assert.rejects(identity.query(`SELECT future_private FROM app.${table}`), { code: '42501' });
    await owner.query('ALTER TABLE app.workspaces DROP COLUMN future_private');

    const userId = randomUUID();
    await identity.query(
      "INSERT INTO app.users (id, name, email, email_verified) VALUES ($1, 'Identity', 'identity@example.test', false)",
      [userId],
    );
    await identity.query(
      "INSERT INTO app.sessions (token, expires_at, updated_at, user_id) VALUES ('token', now() + interval '1 hour', now(), $1)",
      [userId],
    );
    await identity.query(
      "INSERT INTO app.accounts (account_id, provider_id, user_id, updated_at) VALUES ('account', 'provider', $1, now())",
      [userId],
    );
    await identity.query(
      "INSERT INTO app.verifications (identifier, value, expires_at) VALUES ('identifier', 'code', now() + interval '1 hour')",
    );
    for (const [table, assignment] of [
      ['users', "name = 'Updated'"],
      ['sessions', "user_agent = 'Updated'"],
      ['accounts', "scope = 'Updated'"],
      ['verifications', "value = 'Updated'"],
    ]) {
      assert.ok((await identity.query(`SELECT * FROM app.${table}`)).rowCount);
      assert.ok((await identity.query(`UPDATE app.${table} SET ${assignment} RETURNING *`)).rowCount);
    }
    const workspace = (
      await identity.query(
        "INSERT INTO app.workspaces (request_id, created_by, name, slug) VALUES ($1, $2, 'Isolated', 'isolated') RETURNING *",
        [randomUUID(), userId],
      )
    ).rows[0];
    await identity.query('INSERT INTO app.workspace_storage (workspace_id) VALUES ($1)', [workspace.id]);
    assert.deepEqual(
      (
        await identity.query(
          'SELECT workspace_id, generation, stage, runtime_credential, error_code, updated_at FROM app.workspace_storage',
        )
      ).rows.map(({ workspace_id, stage }) => ({ workspace_id, stage })),
      [{ workspace_id: workspace.id, stage: 'reserved' }],
    );
    await owner.query(
      'UPDATE app.workspace_storage SET runtime_credential = \'{"ciphertext":"runtime"}\', migration_credential = \'{"ciphertext":"migration"}\', confirmation_credential = \'{"ciphertext":"confirmation"}\', stage = \'ready\'',
    );
    await bootstrap(adminUrl, passwords);
    assert.deepEqual((await identity.query('SELECT runtime_credential FROM app.workspace_storage')).rows, [
      { runtime_credential: { ciphertext: 'runtime' } },
    ]);
    await assert.rejects(
      identity.query('SELECT migration_credential, confirmation_credential FROM app.workspace_storage'),
      { code: '42501' },
    );
    await assert.rejects(
      identity.query("INSERT INTO app.workspace_storage (workspace_id, stage) VALUES ($1, 'reserved')", [randomUUID()]),
      { code: '42501' },
    );
    await assert.rejects(
      identity.query(
        "INSERT INTO app.workspaces (request_id, created_by, name, slug, ready_at) VALUES ($1, $2, 'Forged', 'forged', now())",
        [randomUUID(), userId],
      ),
      { code: '42501' },
    );
    await owner.query(
      'DELETE FROM app.workspace_storage; DELETE FROM app.workspace_memberships; DELETE FROM app.workspaces',
    );
    for (const table of ['sessions', 'accounts', 'verifications', 'users'])
      assert.ok((await identity.query(`DELETE FROM app.${table} RETURNING *`)).rowCount);

    await administrator.query('CREATE DATABASE migration_cutover OWNER tulipfarm_owner');
    const migrationCutover = await connect(
      `postgresql://tulipfarm_owner:${passwords.owner}@127.0.0.1:${port}/migration_cutover`,
    );
    clients.push(migrationCutover);
    process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';
    await migrate(migrationCutover, directory);
    const migrationMarker = (await migrationCutover.query('SELECT * FROM database_management.storage_capabilities'))
      .rows;
    assert.equal(migrationMarker[0].capability, 'isolated-v1');
    delete process.env.WORKSPACE_STORAGE_CAPABILITY;
    await migrate(migrationCutover, directory);
    process.env.WORKSPACE_STORAGE_CAPABILITY = 'disabled';
    await migrate(migrationCutover, directory);
    assert.deepEqual(
      (await migrationCutover.query('SELECT * FROM database_management.storage_capabilities')).rows,
      migrationMarker,
    );
    const migrationIdentity = await connect(
      `postgresql://tulipfarm:${passwords.application}@127.0.0.1:${port}/migration_cutover`,
    );
    clients.push(migrationIdentity);
    await assert.rejects(migrationIdentity.query('UPDATE app.workspaces SET ready_at = now()'), { code: '42501' });
  } finally {
    if (previousCapability === undefined) delete process.env.WORKSPACE_STORAGE_CAPABILITY;
    else process.env.WORKSPACE_STORAGE_CAPABILITY = previousCapability;
    await Promise.all(clients.map(client => client.end()));
    await exec('docker', ['rm', '--force', container]).catch(() => undefined);
    await rm(directory, { recursive: true });
  }
});

const onboardingDetails = { accountType: 'business', name: 'Sample business', slug: 'sample-business', messages: [] };

async function assertOnboardingAccess(owner, api) {
  const userId = randomUUID();
  await api.query("INSERT INTO app.users (id, name, email, email_verified) VALUES ($1, 'Onboarding', $2, false)", [
    userId,
    `${userId}@example.test`,
  ]);
  const token = randomBytes(32).toString('hex');
  const saved = await saveOnboarding(api, token, onboardingDetails);
  assert.deepEqual(saved.details, onboardingDetails);
  assert.equal((await resumeOnboarding(api, token, userId)).id, saved.id);
  for (const assignment of [
    "details = '{}'::jsonb",
    "token_hash = 'forged'",
    "expires_at = now() + interval '1 year'",
  ]) {
    await assert.rejects(api.query(`UPDATE app.onboarding_drafts SET ${assignment}`), { code: '42501' });
  }
  await owner.query("UPDATE app.onboarding_drafts SET expires_at = now() - interval '1 second' WHERE id = $1", [
    saved.id,
  ]);
  assert.deepEqual((await owner.query('SELECT id, claimed_by FROM app.onboarding_drafts')).rows, [
    { id: saved.id, claimed_by: userId },
  ]);
  await expireOnboarding(api);
  assert.deepEqual((await owner.query('SELECT id FROM app.onboarding_drafts')).rows, []);
}

test(
  "migrations keep the API role's onboarding draft grants across upgrade, reruns, and a fresh install",
  { timeout: 90000 },
  async () => {
    const container = `onboarding-grants-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), 'onboarding-grants-'));
    const clients = [];
    const previousCapability = process.env.WORKSPACE_STORAGE_CAPABILITY;
    try {
      const server = `127.0.0.1:${await startPostgres(container)}`;
      const adminUrl = `postgresql://postgres:disposable-admin-only@${server}/postgres`;
      const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
      const names = (await readdir(migrations)).filter(name => name.endsWith('.sql'));
      const stage = async selected => {
        for (const name of selected)
          await writeFile(join(directory, name), await readFile(join(migrations, name), 'utf8'));
      };

      process.env.WORKSPACE_STORAGE_CAPABILITY = 'disabled';
      await bootstrap(adminUrl, passwords);
      const owner = await connect(`postgresql://tulipfarm_owner:${passwords.owner}@${server}/tulipfarm`);
      clients.push(owner);
      await stage(names.filter(name => name < '0006'));
      await migrate(owner, directory);
      process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';
      await migrate(owner, directory);
      await stage(names.filter(name => name >= '0006'));
      await migrate(owner, directory);
      const api = await connect(`postgresql://tulipfarm:${passwords.application}@${server}/tulipfarm`);
      clients.push(api);
      await assertOnboardingAccess(owner, api);
      for (const rerun of [() => migrate(owner, directory), () => bootstrap(adminUrl, passwords)]) {
        await rerun();
        await assertOnboardingAccess(owner, api);
      }

      const admin = await connect(adminUrl);
      clients.push(admin);
      await admin.query('CREATE DATABASE fresh_install OWNER tulipfarm_owner');
      process.env.WORKSPACE_STORAGE_CAPABILITY = 'disabled';
      const freshOwner = await connect(`postgresql://tulipfarm_owner:${passwords.owner}@${server}/fresh_install`);
      clients.push(freshOwner);
      await migrate(freshOwner, migrations);
      const freshApi = await connect(`postgresql://tulipfarm:${passwords.application}@${server}/fresh_install`);
      clients.push(freshApi);
      await assertOnboardingAccess(freshOwner, freshApi);
    } finally {
      if (previousCapability === undefined) delete process.env.WORKSPACE_STORAGE_CAPABILITY;
      else process.env.WORKSPACE_STORAGE_CAPABILITY = previousCapability;
      await Promise.all(clients.map(client => client.end()));
      await exec('docker', ['rm', '--force', container]).catch(() => undefined);
      await rm(directory, { recursive: true });
    }
  },
);
