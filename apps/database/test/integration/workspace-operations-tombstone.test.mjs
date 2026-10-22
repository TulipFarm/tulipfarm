import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { fixture, connect } from '../../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createWorkspaceMaintenance } from '@tulipfarm/workspaces/lifecycle';
import { commonCompatibility, workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { credentialKeyring, encryptCredential } from '../../../../packages/workspaces/src/credentials.ts';
import { createMigrationCredentialResolver } from '@tulipfarm/workspaces/capabilities';

test(
  'real CLI tombstones, terminates jobs, removes only its aggregate workspace, and delayed setup Activity fails',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const previous = { ...process.env };
    const connection = await Connection.connect({ address: '127.0.0.1:7233' });
    const temporal = new Client({ connection });
    const pool = new Pool({ connectionString: db.connectionString });
    let worker;
    let late;
    let runtime;
    const workflows = [];
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const migrations = await workspaceTableMigrations();
      const a = await db.create(migrations);
      const b = await db.create(migrations);
      process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';
      process.env.WORKSPACE_PROVISIONING_DATABASE_URL = db.connectionString;
      const endpoint = new URL(db.connectionString);
      endpoint.username = '';
      endpoint.password = '';
      process.env.WORKSPACE_DATABASE_ENDPOINT = endpoint.href;
      process.env.WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL = db.connectionString;
      process.env.TEMPORAL_ADDRESS = '127.0.0.1:7233';
      process.env.TEMPORAL_NAMESPACE = 'default';
      process.env.TEMPORAL_STORAGE_TASK_QUEUE = `operations-${randomUUID()}`;
      process.env.R2_ACCESS_KEY_ID = 'unused-tombstone-test';
      process.env.R2_SECRET_ACCESS_KEY = 'unused-tombstone-test';
      for (const capability of ['runtime', 'migration', 'confirmation']) {
        process.env[`WORKSPACE_${capability.toUpperCase()}_KEY`] = randomBytes(32).toString('hex');
        process.env[`WORKSPACE_${capability.toUpperCase()}_KEY_ID`] = 'operations-test';
      }
      for (const workspace of [a, b]) {
        await db.platform.query(
          `WITH u AS (INSERT INTO app.users (name, email, email_verified) VALUES ('Test', replace($1::uuid::text, '-', '') || '@example.test', true) RETURNING id) INSERT INTO app.workspaces (id, request_id, created_by, name, slug) SELECT $1::uuid, gen_random_uuid(), id, 'Test', 'ws-' || replace($1::uuid::text, '-', '') FROM u`,
          [workspace.id],
        );
        const credentials = ['runtime', 'migration', 'confirmation'].map(capability =>
          encryptCredential(
            db.login(workspace, capability),
            { workspaceId: workspace.id, generation: 1, capability },
            credentialKeyring(capability),
          ),
        );
        await db.platform.query(
          `INSERT INTO app.workspace_storage (workspace_id, stage, runtime_credential, migration_credential, confirmation_credential)
        VALUES ($1,'ready',$2,$3,$4)`,
          [workspace.id, ...credentials],
        );
      }
      const initial = await temporal.workflow.start('initializeIsolatedWorkspace', {
        workflowId: `workspace-storage-v1-${a.id}`,
        taskQueue: process.env.TEMPORAL_STORAGE_TASK_QUEUE,
        args: [a.id],
      });
      workflows.push(initial);
      const team = randomUUID(),
        resource = randomUUID(),
        migration = randomUUID(),
        preparing = randomUUID();
      await db.platform.query(`INSERT INTO ${a.names.schema}.tf_teams (id,name) VALUES ($1,'Team')`, [team]);
      await db.platform.query(
        `INSERT INTO ${a.names.schema}.tf_table_catalog (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,'invoices','Invoices','target')`,
        [resource, team],
      );
      await db.platform.query(
        `INSERT INTO ${a.names.schema}.tf_authoring_commands (id,membership_id,table_id,request_id,change,status)
      VALUES ($1,$2,$3,'migration','{}','accepted'), ($4,$2,$3,'preparing','{}','preparing')`,
        [migration, a.membershipId, resource, preparing],
      );
      await db.platform.query(
        `INSERT INTO ${a.names.schema}.tf_migration_jobs (id,table_id,command_id,membership_id,target_revision)
      VALUES ($1,$2,$1,$3,'target')`,
        [migration, resource, a.membershipId],
      );
      await db.platform.query(`INSERT INTO ${a.names.schema}.tf_outbox (id,migration_id) VALUES ($1,$1)`, [migration]);
      for (const [type, id, prefix] of [
        ['migrateTable', migration, 'migration'],
        ['prepareTableSave', preparing, 'save'],
      ]) {
        workflows.push(
          await temporal.workflow.start(type, {
            workflowId: `resource-${prefix}-v1-${a.id}-${id}`,
            taskQueue: process.env.TEMPORAL_STORAGE_TASK_QUEUE,
            args: [a.id, id],
          }),
        );
      }
      const adminUrl = new URL(process.env.TEST_ADMIN_DATABASE_URL);
      const removalUrl = new URL(db.connectionString);
      removalUrl.username = adminUrl.username;
      removalUrl.password = adminUrl.password;
      const cli = (command, args = [], env = process.env) =>
        promisify(execFile)(
          process.execPath,
          [
            new URL('../../src/workspace-operations.ts', import.meta.url).pathname,
            command,
            '--workspace',
            a.id,
            ...args,
          ],
          { env },
        );
      runtime = workspaceRuntime(pool);
      await runtime.transaction(a.id, commonCompatibility, ({ client }) => client.query('SELECT 1'));
      assert.equal(runtime.stats().connections, 1);
      assert.equal(JSON.parse((await cli('status')).stdout).schemaExists, true);
      await assert.rejects(
        cli('teardown', ['--operation', randomUUID()], {
          ...process.env,
          WORKSPACE_PROVISIONING_DATABASE_URL: 'postgresql://owner:secret@production.invalid/production',
        }),
      );
      assert.equal(
        (await db.platform.query('SELECT stage FROM app.workspace_storage WHERE workspace_id=$1', [a.id])).rows[0]
          .stage,
        'ready',
      );
      const operationId = randomUUID();
      const removalEnv = { ...process.env, WORKSPACE_PROVISIONING_DATABASE_URL: removalUrl.href };
      await db.platform.query(
        `CREATE VIEW ${b.names.schema}.external_members AS SELECT id FROM ${a.names.schema}.tf_memberships`,
      );
      await assert.rejects(cli('teardown', ['--operation', operationId], removalEnv));
      for (const workflow of workflows) assert.equal((await workflow.describe()).status.name, 'TERMINATED');
      assert.equal(
        (await db.platform.query(`SELECT status FROM ${a.names.schema}.tf_migration_jobs`)).rows[0].status,
        'rejected',
      );
      assert.equal(
        (await db.platform.query(`SELECT status FROM ${a.names.schema}.tf_authoring_commands WHERE id=$1`, [preparing]))
          .rows[0].status,
        'failed',
      );
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS n FROM ${b.names.schema}.external_members`)).rows[0].n,
        1,
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${a.names.schema}.tf_audit_events WHERE operation='operator.teardown.stopped'`,
          )
        ).rows[0].n,
        1,
      );
      await db.platform.query(`DROP VIEW ${b.names.schema}.external_members`);
      assert.deepEqual(JSON.parse((await cli('teardown', ['--operation', operationId], removalEnv)).stdout), {
        workspaceId: a.id,
        status: 'removed',
      });
      assert.equal((await initial.describe()).status.name, 'TERMINATED');
      assert.deepEqual(JSON.parse((await cli('teardown', ['--operation', operationId], removalEnv)).stdout), {
        workspaceId: a.id,
        status: 'removed',
      });
      await assert.rejects(
        runtime.transaction(a.id, commonCompatibility, () => assert.fail('No tombstoned transaction')),
      );
      await assert.rejects(createMigrationCredentialResolver(pool)(a.id));
      await assert.rejects(connect(db.login(a)));
      const maintenance = createWorkspaceMaintenance({ migrations });
      try {
        await assert.rejects(maintenance.initializeWorkspaceStorage(a.id), /Workspace setup failed/);
      } finally {
        await maintenance.close();
      }
      worker = spawn(process.execPath, ['src/storage-worker.ts'], {
        cwd: new URL('../../../worker/', import.meta.url),
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let workerError = '';
      worker.stderr.on('data', chunk => {
        workerError += chunk;
      });
      late = await temporal.workflow.start('initializeIsolatedWorkspace', {
        workflowId: `delayed-operations-${a.id}`,
        taskQueue: process.env.TEMPORAL_STORAGE_TASK_QUEUE,
        args: [a.id],
      });
      let failed = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        if (worker.exitCode !== null) assert.fail(workerError);
        const description = await temporal.workflowService.describeWorkflowExecution({
          namespace: 'default',
          execution: { workflowId: late.workflowId },
        });
        if (
          description.pendingActivities?.some(activity =>
            activity.lastFailure?.message.includes('Workspace setup failed'),
          )
        ) {
          failed = true;
          break;
        }
        await setTimeout(100);
      }
      assert.ok(failed, 'Real delayed Activity must fail after reading the tombstone');
      assert.equal(
        (await db.platform.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1', [a.names.schema]))
          .rows[0].n,
        0,
      );
      assert.equal(
        (
          await db.platform.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1)', [
            Object.values(a.names).filter(name => name.startsWith('ws_')),
          ])
        ).rows[0].n,
        0,
      );
      await assert.rejects(
        db.platform.query(`UPDATE app.workspace_storage SET stage='reserved' WHERE workspace_id=$1`, [a.id]),
        { code: '55000' },
      );
      const other = await connect(db.login(b));
      try {
        assert.equal(
          (await other.query(`SELECT user_id FROM ${b.names.schema}.tf_memberships`)).rows[0].user_id,
          b.userId,
        );
      } finally {
        await other.end();
      }
      assert.equal((await db.platform.query('SELECT secret FROM app.accounts')).rows[0].secret, 'platform-only');
    } finally {
      for (const workflow of workflows) await workflow.terminate('Disposable test finished').catch(() => undefined);
      await late?.terminate('Disposable test finished').catch(() => undefined);
      if (worker && worker.exitCode === null) {
        const stopped = new Promise(resolve => worker.once('exit', resolve));
        worker.kill('SIGKILL');
        await stopped;
      }
      await runtime?.close();
      await pool.end();
      await connection.close();
      await db.close();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  },
);
