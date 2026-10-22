import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { escapeIdentifier } from 'pg';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { encryptCredential } from '../../../packages/workspaces/src/credentials.ts';
import { encryptInvitationCopy } from '../../../packages/workspaces/src/invitation-copy.ts';
import { fixture, connect, denied } from '../../../packages/workspace-storage/test/integration/fixture.mjs';

test(
  'compiled maintenance startup clears expired invitation copies and recovers after process death with restricted credentials',
  { timeout: 120000 },
  async () => {
    assert.notEqual(process.env.NODE_ENV, 'production');
    assert.equal(process.env.R2_SOUL_BUCKET ?? 'tulipfarm-cloud-soul-local', 'tulipfarm-cloud-soul-local');
    assert.ok(
      process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
      'Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY',
    );
    const f = await fixture();
    const registryRole = `expiry_registry_${randomUUID().replaceAll('-', '')}`;
    const password = randomBytes(32).toString('hex');
    const taskQueue = `invitation-expiry-${randomUUID()}`;
    const keys = Object.fromEntries(
      ['runtime', 'migration', 'confirmation'].map(capability => [
        capability,
        { keyId: 'process-test', key: randomBytes(32) },
      ]),
    );
    let child, connection;
    let output = '';
    async function stop(signal) {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(signal);
      await Promise.race([exited, setTimeout(10000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    async function waitFor(read, accepts) {
      for (let attempt = 0; attempt < 300; attempt++) {
        assert.equal(child.exitCode, null, 'Maintenance process exited before proof');
        assert.equal(child.signalCode, null, 'Maintenance process was killed before proof');
        const result = await read();
        if (accepts(result)) return result;
        await setTimeout(50);
      }
      assert.fail('Maintenance startup did not clear expired copies');
    }
    try {
      await f.platform.query('DROP TABLE app.accounts; SET search_path TO app');
      for (const name of ['0001_baseline.sql']) {
        await f.platform.query(await readFile(new URL(`../../database/migrations/${name}`, import.meta.url), 'utf8'));
      }
      const migrations = await workspaceTableMigrations();
      const workspace = await f.create(migrations);
      const schema = escapeIdentifier(workspace.names.schema);
      await f.platform.query(
        "INSERT INTO app.users (id,name,email,email_verified,created_at,updated_at) VALUES ($1,'Expiry fixture','expiry@example.com',true,now(),now())",
        [workspace.userId],
      );
      await f.platform.query(
        "INSERT INTO app.workspaces (id,request_id,created_by,name,slug,soul_commit,soul_bucket,soul_key,ready_at) VALUES ($1,$2,$3,'Expiry fixture','expiry-fixture',$4,'local-fixture','unused',now())",
        [workspace.id, randomUUID(), workspace.userId, 'a'.repeat(40)],
      );
      const credentials = ['runtime', 'migration', 'confirmation'].map(capability =>
        encryptCredential(
          f.login(workspace, capability),
          { workspaceId: workspace.id, generation: 1, capability },
          keys[capability],
        ),
      );
      await f.platform.query(
        "INSERT INTO app.workspace_storage (workspace_id,stage,runtime_credential,migration_credential,confirmation_credential) VALUES ($1,'ready',$2,$3,$4)",
        [workspace.id, ...credentials],
      );
      await provisionTableRegistry(f.platform, { capability: 'migration', role: registryRole, password });
      const registryURL = new URL(f.connectionString);
      registryURL.username = registryRole;
      registryURL.password = password;
      const registry = await connect(registryURL.href);
      const migration = await connect(f.login(workspace, 'migration'));
      try {
        assert.deepEqual((await registry.query('SELECT workspace_id FROM app.workspace_storage')).rows, [
          { workspace_id: workspace.id },
        ]);
        await denied(registry, 'SELECT * FROM app.users');
        await denied(registry, 'SELECT runtime_credential FROM app.workspace_storage');
        await denied(registry, `SELECT copy_material FROM ${schema}.tf_invitations`);
        await denied(migration, `UPDATE ${schema}.tf_invitations SET email='changed@example.com'`);
        await denied(migration, `SELECT token_hash FROM ${schema}.tf_invitations`);
        await denied(migration, `INSERT INTO ${schema}.tf_memberships (id,user_id,role) VALUES ($1,$2,'admin')`, [
          randomUUID(),
          randomUUID(),
        ]);
      } finally {
        await registry.end();
        await migration.end();
      }
      const copies = [];
      for (const expires of ['expired', 'active', 'restart']) {
        const id = randomUUID();
        const material = encryptInvitationCopy(
          workspace.id,
          id,
          `http://localhost/invite?token=${randomBytes(32).toString('base64url')}`,
          { keyId: 'copy-test', key: randomBytes(32), previous: new Map() },
        );
        await f.platform.query(
          `INSERT INTO ${schema}.tf_invitations (id,issuer_membership_id,kind,email,token_hash,copy_material,expires_at) VALUES ($1,$2,'email',$3,$4,$5,clock_timestamp()+$6::interval)`,
          [
            id,
            workspace.membershipId,
            `${expires}@example.com`,
            randomBytes(32).toString('hex'),
            material,
            expires === 'expired' ? '-1 second' : '7 days',
          ],
        );
        copies.push({ id, material });
      }
      const before = (
        await f.platform.query(
          `SELECT id,token_hash,expires_at,consumed_membership_id,revoked_at FROM ${schema}.tf_invitations ORDER BY id`,
        )
      ).rows;
      const membership = (await f.platform.query(`SELECT * FROM ${schema}.tf_memberships`)).rows;
      const endpoint = new URL(f.connectionString);
      endpoint.username = '';
      endpoint.password = '';
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
        R2_SOUL_BUCKET: 'tulipfarm-cloud-soul-local',
        WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
        WORKSPACE_PROVISIONING_DATABASE_URL: f.connectionString,
        WORKSPACE_DATABASE_ENDPOINT: endpoint.href,
        WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL: registryURL.href,
        TEMPORAL_ADDRESS: '127.0.0.1:7233',
        TEMPORAL_NAMESPACE: 'default',
        TEMPORAL_STORAGE_TASK_QUEUE: taskQueue,
      };
      for (const [capability, key] of Object.entries(keys)) {
        env[`WORKSPACE_${capability.toUpperCase()}_KEY_ID`] = key.keyId;
        env[`WORKSPACE_${capability.toUpperCase()}_KEY`] = key.key.toString('hex');
      }
      function start() {
        child = spawn(process.execPath, ['dist/storage-worker.js'], {
          cwd: new URL('..', import.meta.url),
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', data => {
          output += data;
        });
        child.stderr.on('data', data => {
          output += data;
        });
      }
      const readCopies = async () =>
        (await f.platform.query(`SELECT id,copy_material FROM ${schema}.tf_invitations ORDER BY id`)).rows;
      const expectedCopies = cleared =>
        copies
          .map(copy => ({ id: copy.id, copy_material: cleared.includes(copy.id) ? null : copy.material }))
          .sort((a, b) => a.id.localeCompare(b.id));
      connection = await Connection.connect({ address: '127.0.0.1:7233' });
      const temporal = new Client({ connection, namespace: 'default' });
      async function healthy() {
        assert.equal(
          await temporal.workflow.execute('storageHealthCheck', {
            workflowId: `expiry-health-${randomUUID()}`,
            taskQueue,
            args: [],
            workflowExecutionTimeout: '20 seconds',
          }),
          'isolated-v1',
        );
      }
      start();
      await healthy();
      await waitFor(readCopies, rows => rows.find(row => row.id === copies[0].id).copy_material === null);
      assert.deepEqual(await readCopies(), expectedCopies([copies[0].id]));
      assert.deepEqual(
        (
          await f.platform.query(
            `SELECT id,token_hash,expires_at,consumed_membership_id,revoked_at FROM ${schema}.tf_invitations ORDER BY id`,
          )
        ).rows,
        before,
      );
      await stop('SIGKILL');
      assert.equal(child.signalCode, 'SIGKILL');
      await f.platform.query(
        `UPDATE ${schema}.tf_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [copies[2].id],
      );
      assert.deepEqual(await readCopies(), expectedCopies([copies[0].id]));
      start();
      await healthy();
      await waitFor(readCopies, rows => rows.find(row => row.id === copies[2].id).copy_material === null);
      assert.deepEqual(await readCopies(), expectedCopies([copies[0].id, copies[2].id]));
      assert.deepEqual((await f.platform.query(`SELECT * FROM ${schema}.tf_memberships`)).rows, membership);
      assert.equal((await f.platform.query(`SELECT * FROM ${schema}.tf_audit_events`)).rowCount, 0);
      assert.deepEqual(
        (await f.platform.query(`SELECT name FROM ${schema}.tf_common_migrations ORDER BY name`)).rows.map(
          row => row.name,
        ),
        migrations.map(item => item.name),
      );
      await stop('SIGTERM');
      assert.equal(child.exitCode, 0);
      assert.equal(output.includes('Invitation expiry sweep failed'), false);
      assert.equal(output.includes('Storage maintenance worker failed'), false);
      for (const secret of [
        password,
        ...Object.values(keys).map(key => key.key.toString('hex')),
        ...copies.map(copy => copy.material.ciphertext),
      ]) {
        assert.equal(output.includes(secret), false);
      }
      process.stdout.write(
        `Verified compiled storage worker twice on a random Temporal queue, ${migrations.length} common receipts, 2 expired copies cleared, 1 active copy preserved, SIGKILL recovery, clean shutdown and restricted registry/migration grants. No Soul operations or email sends were requested.\n`,
      );
    } finally {
      await stop('SIGTERM');
      await connection?.close();
      await f.close();
      const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
      try {
        await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(registryRole)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
