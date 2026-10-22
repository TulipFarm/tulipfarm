import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installExtensions } from '../../src/extensions.ts';
import { migrate } from '../../src/migrations.ts';
import { bootstrap, connect } from '../../src/postgres.ts';
import { configureReleaseLogins, releaseLoginPasswords } from '../../src/setup.ts';
import { createEmailLogin, inspectEmailLogin } from '../../src/product-release-access.ts';
import { grantPgvector } from '@tulipfarm/workspace-storage/provisioning';

const exec = promisify(execFile);
const passwords = {
  owner: 'disposable-owner-only',
  application: 'disposable-identity-only',
  temporal: 'disposable-temporal-only',
};

test('a non-superuser admin bootstraps a fresh isolated server and scoped logins', { timeout: 120000 }, async () => {
  const container = `fresh-install-${randomUUID()}`;
  const previousCapability = process.env.WORKSPACE_STORAGE_CAPABILITY;
  const clients = [];
  try {
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
      'pgvector/pgvector:0.8.2-pg18',
    ]);
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec((await exec('docker', ['port', container, '5432/tcp'])).stdout)?.[1];
    assert.ok(port, 'Disposable PostgreSQL must bind only to loopback');
    for (let attempt = 0; ; attempt++) {
      try {
        await exec('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        break;
      } catch (error) {
        if (attempt === 120) throw error;
        await setTimeout(250);
      }
    }
    const admin = database => `postgresql://postgres:disposable-admin-only@127.0.0.1:${port}/${database}`;
    process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';
    const root = await connect(admin('postgres'));
    clients.push(root);
    await root.query("CREATE ROLE setup_master LOGIN CREATEROLE CREATEDB PASSWORD 'disposable-master-only'");
    const master = database => `postgresql://setup_master:disposable-master-only@127.0.0.1:${port}/${database}`;
    await root.query('CREATE ROLE tulipfarm_owner CREATEROLE');
    await assert.rejects(bootstrap(master('postgres'), passwords), /Unexpected elevated role tulipfarm_owner/);
    await root.query('DROP ROLE tulipfarm_owner');
    await bootstrap(master('postgres'), passwords);
    await bootstrap(master('postgres'), passwords);
    const administrator = await connect(admin('tulipfarm'));
    clients.push(administrator);
    await installExtensions(administrator, false);
    const owner = await connect(`postgresql://tulipfarm_owner:${passwords.owner}@127.0.0.1:${port}/tulipfarm`);
    clients.push(owner);
    await migrate(owner, fileURLToPath(new URL('../../migrations/', import.meta.url)));
    await grantPgvector(administrator, 'setup_master', true);
    const setup = await connect(master('tulipfarm'));
    clients.push(setup);
    await configureReleaseLogins(setup, 'tulipfarm', releaseLoginPasswords());
    await createEmailLogin(setup, 'disposable-email-password-at-least-24');
    assert.equal(await inspectEmailLogin(setup), 'retained');
    const icon = await administrator.query(
      "SELECT has_column_privilege('tulipfarm', 'app.workspaces', 'icon', 'SELECT') AS read, has_column_privilege('tulipfarm', 'app.workspaces', 'icon', 'INSERT') AS write",
    );
    assert.deepEqual(icon.rows, [{ read: true, write: true }]);
  } finally {
    await Promise.all(clients.map(client => client.end()));
    if (previousCapability === undefined) delete process.env.WORKSPACE_STORAGE_CAPABILITY;
    else process.env.WORKSPACE_STORAGE_CAPABILITY = previousCapability;
    await exec('docker', ['rm', '--force', container]).catch(() => {});
  }
});
