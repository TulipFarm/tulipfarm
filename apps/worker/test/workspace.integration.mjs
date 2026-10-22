import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { soulStorageConfig, verifyStarterBundle } from '@tulipfarm/workspaces/soul';
import { commonCompatibility, workspaceRuntime } from '@tulipfarm/workspaces/storage';
import {
  createMigrationCredentialResolver,
  createConfirmationCredentialResolver,
} from '@tulipfarm/workspaces/capabilities';
import { createWorkspaceMaintenance } from '@tulipfarm/workspaces/lifecycle';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { rotateWorkspaceCredentials, disableWorkspace } from '@tulipfarm/workspaces/operators';
import { credentialKeyring, decryptCredential } from '../../../packages/workspaces/src/credentials.ts';
import { workspaceNames, qualified, commonTables } from '../../../packages/workspace-storage/src/runtime.ts';
import { createAuth } from '../../api/src/auth.ts';
import { buildApp } from '../../api/src/app.ts';
import { createTemporalClient } from '../../api/src/temporal.ts';
import { readMigrations } from '../../database/src/migrations.ts';

test(
  'two API workspaces complete through isolated maintenance, restricted logins, real R2 and retries',
  { timeout: 180000 },
  async t => {
    const storage = soulStorageConfig();
    assert.equal(storage.bucket, 'tulipfarm-cloud-soul-local');
    const token = randomUUID().replaceAll('-', '');
    const database = `lifecycle_${token}`;
    const owner = `lc_owner_${token}`;
    const identity = `lc_identity_${token}`;
    const registries = [];
    const password = randomBytes(32).toString('hex');
    const admin = new Pool({ connectionString: 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres' });
    const oldEnv = { ...process.env };
    process.env.TURNSTILE_SITE_KEY = 'lifecycle-fixture-site';
    process.env.TURNSTILE_SECRET_KEY = 'lifecycle-fixture-secret';
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return originalFetch(url, options);
      assert.equal(options.body.get('response'), 'lifecycle-fixture-token');
      return Response.json({ success: true, hostname: 'localhost', action: 'create_workspace' });
    });
    if (process.env.AGENT_TEST_USE_LOCAL_WRITER_FOR_READS === '1') {
      process.env.R2_SOUL_READ_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
      process.env.R2_SOUL_READ_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    }
    const ownerURL = `postgresql://${owner}:${password}@127.0.0.1:5432/${database}`;
    const identityURL = `postgresql://${identity}:${password}@127.0.0.1:5432/${database}`;
    const pool = new Pool({ connectionString: ownerURL, options: '-c search_path=app' });
    const identityPool = new Pool({ connectionString: identityURL, options: '-c search_path=app' });
    const temporal = createTemporalClient();
    const workspaces = [];
    let worker;
    let app;
    let runtime;
    async function stopWorker() {
      if (!worker || worker.exitCode !== null) return;
      const exited = new Promise(resolve => worker.once('exit', resolve));
      worker.kill('SIGKILL');
      await exited;
      worker = undefined;
    }
    async function waitForFailures(stage) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const result = await pool.query(
          `SELECT count(*)::integer AS n FROM app.workspace_storage WHERE stage = $1 AND error_code = 'setup_failed'`,
          [stage],
        );
        if (result.rows[0].n === 2) return;
        await setTimeout(100);
      }
      assert.fail(`Both workspaces must reach injected failure at ${stage}`);
    }
    try {
      await admin.query(
        `CREATE ROLE ${escapeIdentifier(owner)} LOGIN CREATEROLE NOSUPERUSER NOCREATEDB PASSWORD ${escapeLiteral(password)}`,
      );
      await admin.query(
        `CREATE ROLE ${escapeIdentifier(identity)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${escapeLiteral(password)}`,
      );
      await admin.query(`CREATE DATABASE ${escapeIdentifier(database)} OWNER ${escapeIdentifier(owner)}`);
      await provisionTestPgvector(admin, database, owner);
      await admin.query(`REVOKE ALL ON DATABASE ${escapeIdentifier(database)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(identity)}`);
      for (const migration of await readMigrations(
        fileURLToPath(new URL('../../database/migrations', import.meta.url)),
      ))
        await pool.query(migration.sql);
      await pool.query(`GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(identity)}`);
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON app.users, app.sessions, app.accounts, app.verifications, app.workspaces, app.api_rate_limits TO ${escapeIdentifier(identity)}`,
      );
      await pool.query(
        `GRANT SELECT (workspace_id, generation, stage, runtime_credential, error_code, updated_at), INSERT (workspace_id) ON app.workspace_storage TO ${escapeIdentifier(identity)}`,
      );
      process.env.DATABASE_URL = identityURL;
      process.env.EMAIL_DELIVERY_KEY_ID = 'test-email';
      process.env.EMAIL_DELIVERY_KEY = randomBytes(32).toString('hex');
      process.env.INTEGRATION_CREDENTIAL_KEY_ID = 'test-integration';
      process.env.INTEGRATION_CREDENTIAL_KEY = randomBytes(32).toString('hex');
      process.env.WORKSPACE_PROVISIONING_DATABASE_URL = ownerURL;
      process.env.WORKSPACE_DATABASE_ENDPOINT = `postgresql://127.0.0.1:5432/${database}`;
      process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';
      process.env.TEMPORAL_STORAGE_TASK_QUEUE = `storage-e2e-${token}`;
      for (const capability of ['RUNTIME', 'MIGRATION', 'CONFIRMATION']) {
        process.env[`WORKSPACE_${capability}_KEY`] = randomBytes(32).toString('hex');
        process.env[`WORKSPACE_${capability}_KEY_ID`] = 'test-v1';
      }
      for (const capability of ['confirmation', 'migration']) {
        const role = `lc_${capability}_${token}`;
        const client = await pool.connect();
        try {
          await provisionTableRegistry(client, { capability, role, password });
        } finally {
          client.release();
        }
        registries.push(role);
        process.env[`WORKSPACE_${capability.toUpperCase()}_REGISTRY_DATABASE_URL`] =
          `postgresql://${role}:${password}@127.0.0.1:5432/${database}`;
      }
      function buildRuntimeApp() {
        const privileged = [
          'WORKSPACE_PROVISIONING_DATABASE_URL',
          'WORKSPACE_MIGRATION_KEY',
          'WORKSPACE_MIGRATION_PREVIOUS_KEYS',
          'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
        ];
        const saved = new Map(privileged.map(key => [key, process.env[key]]));
        for (const key of privileged) delete process.env[key];
        const instance = buildApp();
        instance.log.level = 'error';
        return instance
          .ready()
          .then(() => instance)
          .finally(() => {
            for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
          });
      }
      async function signIn(name) {
        let link;
        const auth = createAuth(
          identityPool,
          async data => {
            link = data.url;
          },
          async () => {},
        );
        await auth.api.signInMagicLink({
          headers: new Headers({ origin: 'http://localhost:5173' }),
          body: { email: `${randomUUID()}@example.com`, name },
        });
        const verified = await auth.handler(new Request(link));
        const cookie = verified.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; ');
        const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
        return { headers: { cookie, origin: 'http://localhost:5173' }, userId: session.user.id };
      }
      const users = [await signIn('Workspace A'), await signIn('Workspace B')];
      app = await buildRuntimeApp();
      const invalidPayload = { requestId: randomUUID(), name: 'Reserved', slug: 'settings' };
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/workspaces',
            headers: users[0].headers,
            payload: invalidPayload,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/workspaces',
            headers: { origin: 'http://localhost:5173' },
            payload: invalidPayload,
          })
        ).statusCode,
        401,
      );
      for (let index = 0; index < 2; index++) {
        await pool.query("UPDATE app.api_rate_limits SET expires_at = now() - interval '1 second'");
        const user = users[index];
        const payload = {
          requestId: randomUUID(),
          name: `Workspace ${index}`,
          slug: `workspace-${index}`,
          challengeToken: 'lifecycle-fixture-token',
        };
        const results = await Promise.all(
          Array.from({ length: 2 }, () =>
            app.inject({ method: 'POST', url: '/v1/workspaces', headers: user.headers, payload }),
          ),
        );
        for (const result of results) assert.equal(result.statusCode, 202, result.body);
        assert.equal(new Set(results.map(result => result.json().id)).size, 1);
        const workspace = { ...results[0].json(), payload, user };
        workspaces.push(workspace);
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/workspaces',
              headers: user.headers,
              payload: { ...payload, requestId: randomUUID() },
            })
          ).statusCode,
          409,
        );
        const setup = await app.inject({ url: `/v1/workspace-setups/${workspace.id}`, headers: user.headers });
        assert.deepEqual(setup.json(), { id: workspace.id, stage: 'reserved', error: null });
        assert.equal(
          (await app.inject({ url: `/v1/workspaces/${workspace.slug}`, headers: user.headers })).statusCode,
          404,
        );
        assert.equal(
          (await app.inject({ url: `/v1/workspace-setups/${workspace.id}`, headers: users[1 - index].headers }))
            .statusCode,
          404,
        );
      }
      const migrations = await workspaceTableMigrations();
      const workerEnv = { ...process.env };
      delete workerEnv.DATABASE_URL;
      function startWorker() {
        worker = spawn(process.execPath, ['src/storage-worker.ts'], {
          cwd: new URL('..', import.meta.url),
          env: workerEnv,
          stdio: ['ignore', 'ignore', 'inherit'],
        });
      }
      await pool.query(`CREATE FUNCTION app.fail_setup_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.stage <> OLD.stage THEN RAISE EXCEPTION 'injected lost provisioning acknowledgement'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_setup_transition BEFORE UPDATE ON app.workspace_storage FOR EACH ROW EXECUTE FUNCTION app.fail_setup_transition()`);
      startWorker();
      await waitForFailures('reserved');
      await stopWorker();
      for (const workspace of workspaces) {
        assert.equal(
          (
            await pool.query(
              `SELECT count(*)::integer AS n FROM ${qualified(workspaceNames(workspace.id).schema, commonTables.memberships)}`,
            )
          ).rows[0].n,
          1,
        );
      }
      await pool.query(`CREATE OR REPLACE FUNCTION app.fail_setup_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.stage = 'ready' THEN RAISE EXCEPTION 'injected lost Soul acknowledgement'; END IF; RETURN NEW; END $$`);
      startWorker();
      await waitForFailures('database');
      await stopWorker();
      for (const workspace of workspaces) {
        const setup = await app.inject({
          url: `/v1/workspace-setups/${workspace.id}`,
          headers: workspace.user.headers,
        });
        assert.deepEqual(setup.json(), { id: workspace.id, stage: 'database', error: 'setup_failed' });
        assert.equal(
          (await app.inject({ url: `/v1/workspaces/${workspace.slug}`, headers: workspace.user.headers })).statusCode,
          404,
        );
      }
      await pool.query(
        'DROP TRIGGER fail_setup_transition ON app.workspace_storage; DROP FUNCTION app.fail_setup_transition()',
      );
      startWorker();
      for (const workspace of workspaces) {
        const workflow = temporal.client.workflow.getHandle(`workspace-storage-v1-${workspace.id}`);
        await temporal.connection.withDeadline(Date.now() + 90000, () => workflow.result());
        const response = await app.inject({ url: `/v1/workspaces/${workspace.slug}`, headers: workspace.user.headers });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().status, 'ready');
        const object = await storage.client.send(
          new GetObjectCommand({ Bucket: storage.bucket, Key: `workspaces/${workspace.id}/soul/initial.bundle` }),
        );
        assert.equal(
          await verifyStarterBundle(await object.Body.transformToByteArray(), {
            workspaceId: workspace.id,
            createdBy: workspace.user.userId,
            createdAt: workspace.createdAt,
          }),
          response.json().soulCommit,
        );
        const names = workspaceNames(workspace.id);
        assert.equal(
          (await pool.query(`SELECT role FROM ${qualified(names.schema, commonTables.memberships)}`)).rows[0].role,
          'admin',
        );
        assert.equal(
          (await pool.query(`SELECT count(*)::integer AS n FROM ${qualified(names.schema, commonTables.provisioning)}`))
            .rows[0].n,
          1,
        );
      }
      runtime = workspaceRuntime(identityPool);
      const [a, b] = workspaces;
      for (const [capability, resolve] of [
        ['migration', createMigrationCredentialResolver(pool)],
        ['confirmation', createConfirmationCredentialResolver(pool)],
      ]) {
        const credential = await resolve(a.id);
        const login = new Pool({ connectionString: credential.connectionString });
        try {
          assert.equal(
            (await login.query('SELECT current_user')).rows[0].current_user,
            workspaceNames(a.id)[capability],
          );
          await assert.rejects(
            login.query(`SELECT * FROM ${qualified(workspaceNames(b.id).schema, commonTables.memberships)}`),
            error => error.code === '42501',
          );
        } finally {
          await login.end();
        }
      }
      await runtime.transaction(a.id, commonCompatibility, async ({ client, schema }) => {
        assert.equal((await client.query('SELECT current_user')).rows[0].current_user, workspaceNames(a.id).runtime);
        assert.equal(
          (await client.query(`SELECT user_id FROM ${qualified(schema, commonTables.memberships)}`)).rows[0].user_id,
          a.user.userId,
        );
      });
      for (const target of [qualified(workspaceNames(b.id).schema, commonTables.memberships), 'app.accounts']) {
        await assert.rejects(
          runtime.transaction(a.id, commonCompatibility, ({ client }) => client.query(`SELECT * FROM ${target}`)),
          error => error.code === '42501',
        );
      }
      await assert.rejects(
        identityPool.query('SELECT migration_credential FROM app.workspace_storage'),
        error => error.code === '42501',
      );
      await assert.rejects(
        runtime.transaction(a.id, { minimum: 1, maximum: commonCompatibility.maximum - 1 }, () =>
          assert.fail('incompatible callback must not execute'),
        ),
      );
      assert.equal((await app.inject({ url: `/v1/workspaces/${b.slug}`, headers: a.user.headers })).statusCode, 404);
      assert.deepEqual(
        (await app.inject({ url: '/v1/workspaces', headers: a.user.headers })).json().map(value => value.id),
        [a.id],
      );
      const original = (
        await pool.query('SELECT generation, runtime_credential FROM app.workspace_storage WHERE workspace_id = $1', [
          a.id,
        ])
      ).rows[0];
      const oldURL = decryptCredential(
        original.runtime_credential,
        { workspaceId: a.id, generation: 1, capability: 'runtime' },
        credentialKeyring('runtime'),
      );
      const rotation = {
        workspaceId: a.id,
        operationId: randomUUID(),
        expectedGeneration: 1,
        kind: 'rotate-passwords',
      };
      await pool.query(`CREATE FUNCTION app.fail_rotation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.generation <> OLD.generation THEN RAISE EXCEPTION 'injected rotation rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_rotation BEFORE UPDATE ON app.workspace_storage FOR EACH ROW EXECUTE FUNCTION app.fail_rotation()`);
      await assert.rejects(rotateWorkspaceCredentials(pool, rotation), /injected rotation rollback/);
      const oldLogin = new Pool({ connectionString: oldURL });
      try {
        assert.equal((await oldLogin.query('SELECT current_user')).rows[0].current_user, workspaceNames(a.id).runtime);
      } finally {
        await oldLogin.end();
      }
      assert.equal(
        (await pool.query('SELECT generation FROM app.workspace_storage WHERE workspace_id = $1', [a.id])).rows[0]
          .generation,
        1,
      );
      await pool.query('DROP TRIGGER fail_rotation ON app.workspace_storage; DROP FUNCTION app.fail_rotation()');
      let releaseHeld;
      let admitted;
      const admittedPromise = new Promise(resolve => {
        admitted = resolve;
      });
      const hold = new Promise(resolve => {
        releaseHeld = resolve;
      });
      const held = runtime.transaction(a.id, commonCompatibility, async ({ client }) => {
        admitted();
        await hold;
        return (await client.query('SELECT current_user')).rows[0].current_user;
      });
      await admittedPromise;
      const rotated = await rotateWorkspaceCredentials(pool, rotation);
      assert.equal(rotated.generation, 2);
      assert.deepEqual(await rotateWorkspaceCredentials(pool, rotation), rotated);
      await runtime.transaction(a.id, commonCompatibility, async ({ client }) => {
        assert.equal((await client.query('SELECT current_user')).rows[0].current_user, workspaceNames(a.id).runtime);
      });
      releaseHeld();
      assert.equal(await held, workspaceNames(a.id).runtime);
      const staleLogin = new Pool({ connectionString: oldURL });
      try {
        await assert.rejects(staleLogin.query('SELECT 1'), error => error.code === '28P01');
      } finally {
        await staleLogin.end();
      }
      for (const capability of ['RUNTIME', 'MIGRATION', 'CONFIRMATION']) {
        process.env[`WORKSPACE_${capability}_PREVIOUS_KEYS`] = JSON.stringify({
          'test-v1': process.env[`WORKSPACE_${capability}_KEY`],
        });
        process.env[`WORKSPACE_${capability}_KEY`] = randomBytes(32).toString('hex');
        process.env[`WORKSPACE_${capability}_KEY_ID`] = 'test-v2';
      }
      await app.close();
      app = await buildRuntimeApp();
      const operationId = randomUUID();
      const args = [
        fileURLToPath(new URL('../../database/src/workspace-credentials.ts', import.meta.url)),
        'rotate-keys',
        a.id,
        operationId,
        '2',
      ];
      const firstCLI = await promisify(execFile)(process.execPath, args, { env: process.env });
      const retryCLI = await promisify(execFile)(process.execPath, args, { env: process.env });
      assert.equal(firstCLI.stdout, retryCLI.stdout);
      assert.equal(JSON.parse(firstCLI.stdout).generation, 3);
      assert.equal((await app.inject({ url: `/v1/workspaces/${a.slug}`, headers: a.user.headers })).statusCode, 200);
      const keyRow = (
        await pool.query('SELECT runtime_credential FROM app.workspace_storage WHERE workspace_id = $1', [a.id])
      ).rows[0];
      assert.equal(keyRow.runtime_credential.keyId, 'test-v2');
      await runtime.close();
      runtime = workspaceRuntime(identityPool);
      await pool.query(`UPDATE app.workspaces SET name = 'Renamed', slug = 'renamed' WHERE id = $1`, [a.id]);
      assert.equal((await app.inject({ url: '/v1/workspaces/renamed', headers: a.user.headers })).json().id, a.id);
      const table = qualified(workspaceNames(a.id).schema, commonTables.memberships);
      const creatorMembership = (
        await pool.query(`SELECT id FROM ${table} WHERE user_id = $1 AND removed_at IS NULL`, [a.user.userId])
      ).rows[0].id;
      const replacementAdmin = randomUUID();
      await runtime.transaction(a.id, commonCompatibility, async ({ client, schema }) => {
        await client.query(
          `SELECT id FROM ${qualified(schema, commonTables.authorizationLock)} WHERE id = 1 FOR UPDATE`,
        );
        await client.query(`INSERT INTO ${table} (id, user_id, role) VALUES ($1, $2, 'admin')`, [
          replacementAdmin,
          b.user.userId,
        ]);
        await client.query(`UPDATE ${table} SET role = 'member' WHERE id = $1`, [creatorMembership]);
      });
      await pool.query(`UPDATE app.workspaces SET name = $2, slug = $3 WHERE id = $1`, [
        a.id,
        a.payload.name,
        a.payload.slug,
      ]);
      await pool.query("UPDATE app.api_rate_limits SET expires_at = now() - interval '1 second'");
      const demotedReplay = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: a.user.headers,
        payload: a.payload,
      });
      assert.equal(demotedReplay.statusCode, 200, demotedReplay.body);
      assert.equal(demotedReplay.json().id, a.id);
      const demotedRerun = await temporal.client.workflow.start('initializeIsolatedWorkspace', {
        workflowId: `demoted-retry-${a.id}`,
        taskQueue: process.env.TEMPORAL_STORAGE_TASK_QUEUE,
        args: [a.id],
      });
      await temporal.connection.withDeadline(Date.now() + 30000, () => demotedRerun.result());
      assert.deepEqual(
        (await pool.query(`SELECT id, role FROM ${table} WHERE user_id = $1 AND removed_at IS NULL`, [a.user.userId]))
          .rows,
        [{ id: creatorMembership, role: 'member' }],
      );
      await runtime.transaction(a.id, commonCompatibility, async ({ client, schema }) => {
        await client.query(
          `SELECT id FROM ${qualified(schema, commonTables.authorizationLock)} WHERE id = 1 FOR UPDATE`,
        );
        await client.query(`UPDATE ${table} SET removed_at = CURRENT_TIMESTAMP WHERE user_id = $1`, [a.user.userId]);
        await client.query(`UPDATE ${table} SET removed_at = CURRENT_TIMESTAMP WHERE id = $1`, [replacementAdmin]);
      });
      await pool.query(`UPDATE app.workspaces SET name = $2, slug = $3 WHERE id = $1`, [
        a.id,
        a.payload.name,
        a.payload.slug,
      ]);
      await pool.query("UPDATE app.api_rate_limits SET expires_at = now() - interval '1 second'");
      assert.equal(
        (await app.inject({ method: 'POST', url: '/v1/workspaces', headers: a.user.headers, payload: a.payload }))
          .statusCode,
        404,
      );
      const rerun = await temporal.client.workflow.start('initializeIsolatedWorkspace', {
        workflowId: `retry-${a.id}`,
        taskQueue: process.env.TEMPORAL_STORAGE_TASK_QUEUE,
        args: [a.id],
      });
      await temporal.connection.withDeadline(Date.now() + 30000, () => rerun.result());
      assert.equal(
        (await pool.query(`SELECT count(*)::integer AS n FROM ${table} WHERE removed_at IS NULL`)).rows[0].n,
        0,
      );
      assert.deepEqual((await app.inject({ url: '/v1/workspaces', headers: a.user.headers })).json(), []);
      assert.equal(
        (await app.inject({ url: `/v1/workspace-setups/${a.id}`, headers: a.user.headers })).json().stage,
        'ready',
      );
      await stopWorker();
      await pool.query(`UPDATE app.workspace_storage SET stage = 'database' WHERE workspace_id = $1`, [a.id]);
      const maintenance = createWorkspaceMaintenance({ migrations });
      try {
        await assert.rejects(maintenance.initializeWorkspaceStorage(a.id), /Workspace setup failed/);
      } finally {
        await maintenance.close();
      }
      assert.equal(
        (await pool.query('SELECT stage FROM app.workspace_storage WHERE workspace_id = $1', [a.id])).rows[0].stage,
        'database',
      );
      assert.equal(
        (await pool.query(`SELECT count(*)::integer AS n FROM ${table} WHERE removed_at IS NULL`)).rows[0].n,
        0,
      );
      await pool.query(`UPDATE app.workspace_storage SET runtime_credential = '{}' WHERE workspace_id = $1`, [b.id]);
      assert.equal((await app.inject({ url: '/v1/workspaces', headers: a.user.headers })).statusCode, 503);
      assert.equal((await identityPool.query('SELECT count(*)::integer AS n FROM app.users')).rows[0].n, 2);
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 739))', [b.id]);
      let disableFinished = false;
      const disabling = disableWorkspace(pool, b.id.toUpperCase(), randomUUID()).then(value => {
        disableFinished = true;
        return value;
      });
      await setTimeout(100);
      assert.equal(disableFinished, false, 'Uppercase UUID must serialize with lowercase setup lock');
      await blocker.query('COMMIT');
      blocker.release();
      const disabled = await disabling;
      assert.equal(disabled.stage, 'unavailable');
      assert.deepEqual(await disableWorkspace(pool, b.id, randomUUID()), disabled);
      await assert.rejects(
        pool.query(
          `UPDATE app.workspace_storage SET stage = 'ready', disabled_at = NULL, disabled_operation_id = NULL WHERE workspace_id = $1`,
          [b.id],
        ),
        error => error.code === '55000',
      );
      await assert.rejects(
        pool.query('DELETE FROM app.workspace_storage WHERE workspace_id = $1', [b.id]),
        error => error.code === '55000',
      );
      await pool.query(`DROP SCHEMA ${escapeIdentifier(workspaceNames(b.id).schema)} CASCADE`);
      const late = createWorkspaceMaintenance({ migrations });
      try {
        await assert.rejects(late.initializeWorkspaceStorage(b.id.toUpperCase()), /Workspace setup failed/);
      } finally {
        await late.close();
      }
      assert.equal(
        (
          await pool.query('SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname = $1', [
            workspaceNames(b.id).schema,
          ])
        ).rows[0].n,
        0,
      );
      await assert.rejects(
        rotateWorkspaceCredentials(pool, { ...rotation, workspaceId: b.id, operationId: randomUUID() }),
        /permanently disabled/,
      );
      await assert.rejects(
        runtime.transaction(b.id, commonCompatibility, () => assert.fail('Disabled callback must not execute')),
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: '/v1/workspaces', headers: b.user.headers, payload: b.payload }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: `/v1/workspace-setups/${b.id}`, headers: b.user.headers })).json().stage,
        'unavailable',
      );
      const pendingPayload = {
        name: 'Disabled before setup',
        slug: 'disabled-before-setup',
        requestId: randomUUID(),
        challengeToken: 'lifecycle-fixture-token',
      };
      await pool.query("UPDATE app.api_rate_limits SET expires_at = now() - interval '1 second'");
      const pendingResult = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: b.user.headers,
        payload: pendingPayload,
      });
      assert.equal(pendingResult.statusCode, 202);
      const pendingWorkspace = pendingResult.json();
      workspaces.push(pendingWorkspace);
      await disableWorkspace(pool, pendingWorkspace.id, randomUUID());
      const pendingLate = createWorkspaceMaintenance({ migrations });
      try {
        await assert.rejects(pendingLate.initializeWorkspaceStorage(pendingWorkspace.id), /Workspace setup failed/);
      } finally {
        await pendingLate.close();
      }
      assert.equal(
        (
          await pool.query('SELECT count(*)::integer AS n FROM pg_roles WHERE rolname = $1', [
            workspaceNames(pendingWorkspace.id).runtime,
          ])
        ).rows[0].n,
        0,
      );
    } finally {
      if (app) await app.close();
      await runtime?.close();
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        const exited = new Promise(resolve => worker.once('exit', resolve));
        worker.kill('SIGTERM');
        await Promise.race([exited, setTimeout(10000)]);
        if (worker.exitCode === null) {
          worker.kill('SIGKILL');
          await exited;
        }
      }
      for (const workspace of workspaces) {
        const workflow = temporal.client.workflow.getHandle(`workspace-storage-v1-${workspace.id}`);
        if ((await workflow.describe()).status.name === 'RUNNING') await workflow.terminate('Disposable test finished');
        await storage.client.send(
          new DeleteObjectCommand({ Bucket: storage.bucket, Key: `workspaces/${workspace.id}/soul/initial.bundle` }),
        );
      }
      await temporal.connection.close();
      storage.client.destroy();
      await pool.end();
      await identityPool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)} WITH (FORCE)`);
      for (const workspace of workspaces)
        for (const key of ['runtime', 'migration', 'confirmation', 'customOwner']) {
          await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(workspaceNames(workspace.id)[key])}`);
        }
      await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(identity)}, ${escapeIdentifier(owner)}`);
      for (const role of registries) await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      await admin.end();
      for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
      Object.assign(process.env, oldEnv);
    }
  },
);
import { provisionTestPgvector } from '../../../packages/workspace-storage/test/integration/pgvector.fixture.mjs';
