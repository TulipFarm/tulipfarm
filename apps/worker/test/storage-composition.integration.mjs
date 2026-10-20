import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { workspaceNames } from '../../../packages/workspace-storage/src/runtime.ts';
import { createAuth } from '../../api/src/auth.ts';
import { buildApp } from '../../api/src/app.ts';
import { createTemporalClient } from '../../api/src/temporal.ts';
import { readMigrations } from '../../database/src/migrations.ts';
import { createWorkspaceMember } from '../../../packages/tables/test/fixture.mjs';

test(
  'actual API and isolated workers execute approved chat table proposals with split credentials',
  { timeout: 240000 },
  async t => {
    const storage = soulStorageConfig();
    const stream = await workspaceTableMigrations();
    assert.equal(storage.bucket, 'tulipfarm-cloud-soul-local');
    const oldEnv = { ...process.env };
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return originalFetch(url, options);
      assert.equal(options.body.get('response'), 'XXXX.DUMMY.TOKEN.XXXX');
      return Response.json({ success: true, metadata: { result_with_testing_key: true } });
    });
    if (process.env.AGENT_TEST_USE_LOCAL_WRITER_FOR_READS === '1') {
      process.env.R2_SOUL_READ_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
      process.env.R2_SOUL_READ_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    }
    const token = randomUUID().replaceAll('-', '');
    const database = `composition_${token}`;
    const owner = `cp_owner_${token}`;
    const identity = `cp_identity_${token}`;
    const password = randomBytes(32).toString('hex');
    const adminURL =
      process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres';
    const server = new URL(adminURL).host;
    const admin = new Pool({ connectionString: adminURL });
    const ownerURL = `postgresql://${owner}:${password}@${server}/${database}`;
    const identityURL = `postgresql://${identity}:${password}@${server}/${database}`;
    const ownerPool = new Pool({ connectionString: ownerURL, options: '-c search_path=app' });
    const identityPool = new Pool({ connectionString: identityURL, options: '-c search_path=app' });
    const temporal = createTemporalClient();
    const registries = [];
    const workers = [];
    const workspaces = [];
    const approved = [];
    let app;
    let workerOutput = '';
    async function waitFor(read, accepts, description) {
      for (let attempt = 0; attempt < 600; attempt++) {
        const value = await read();
        if (accepts(value)) return value;
        for (const worker of workers) assert.equal(worker.exitCode, null, `Worker exited: ${workerOutput}`);
        await setTimeout(150);
      }
      assert.fail(`${description}: ${workerOutput}`);
    }
    function startWorker(entry, env) {
      const worker = spawn(process.execPath, [entry], {
        cwd: new URL('..', import.meta.url),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      worker.stdout.on('data', data => {
        workerOutput = (workerOutput + data.toString()).slice(-20000);
      });
      worker.stderr.on('data', data => {
        workerOutput = (workerOutput + data.toString()).slice(-20000);
      });
      workers.push(worker);
      return worker;
    }
    async function request(method, url, headers, payload, status = 200) {
      const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
      assert.equal(response.statusCode, status, response.body);
      return response.json();
    }
    try {
      await admin.query(`CREATE ROLE ${escapeIdentifier(owner)} LOGIN CREATEROLE PASSWORD ${escapeLiteral(password)}`);
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
        await ownerPool.query(migration.sql);
      await ownerPool.query(`GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(identity)};
      GRANT SELECT, INSERT, UPDATE, DELETE ON app.users, app.sessions, app.accounts, app.verifications, app.api_rate_limits TO ${escapeIdentifier(identity)};
      GRANT SELECT (id, request_id, created_by, name, slug, created_at, soul_commit, soul_bucket, soul_key, ready_at, creation_name, settings_revision), INSERT (request_id, created_by, name, slug) ON app.workspaces TO ${escapeIdentifier(identity)};
      GRANT SELECT ON app.workspace_settings_commands TO ${escapeIdentifier(identity)};
      GRANT SELECT (workspace_id, generation, stage, runtime_credential, error_code, updated_at), INSERT (workspace_id) ON app.workspace_storage TO ${escapeIdentifier(identity)}`);
      const registryURLs = {};
      const confirmationRole = `cp_confirmation_${token}`;
      for (const capability of ['authoring', 'confirmation', 'migration']) {
        const role = `cp_${capability}_${token}`;
        const client = await ownerPool.connect();
        try {
          await provisionTableRegistry(client, { capability, role, password });
        } finally {
          client.release();
        }
        registries.push(role);
        registryURLs[capability] = `postgresql://${role}:${password}@${server}/${database}`;
      }
      process.env.DATABASE_URL = identityURL;
      process.env.EMAIL_DELIVERY_KEY_ID = 'test-email';
      process.env.EMAIL_DELIVERY_KEY = randomBytes(32).toString('hex');
      process.env.INTEGRATION_CREDENTIAL_KEY_ID = 'test-integration';
      process.env.INTEGRATION_CREDENTIAL_KEY = randomBytes(32).toString('hex');
      process.env.WORKSPACE_STORAGE_CAPABILITY = 'isolated-v1';
      process.env.TEMPORAL_TASK_QUEUE = `composition-authoring-${token}`;
      process.env.TEMPORAL_STORAGE_TASK_QUEUE = `composition-maintenance-${token}`;
      process.env.WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL = registryURLs.confirmation;
      for (const capability of ['RUNTIME', 'MIGRATION', 'CONFIRMATION']) {
        process.env[`WORKSPACE_${capability}_KEY`] = randomBytes(32).toString('hex');
        process.env[`WORKSPACE_${capability}_KEY_ID`] = 'test-v1';
      }
      const maintenanceEnv = {
        ...process.env,
        WORKSPACE_PROVISIONING_DATABASE_URL: ownerURL,
        WORKSPACE_DATABASE_ENDPOINT: `postgresql://${server}/${database}`,
        WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL: registryURLs.migration,
      };
      delete maintenanceEnv.DATABASE_URL;
      delete maintenanceEnv.WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL;
      const ordinaryEnv = { ...process.env, WORKSPACE_AUTHORING_DATABASE_URL: registryURLs.authoring };
      for (const key of [
        'DATABASE_URL',
        'WORKSPACE_MIGRATION_KEY',
        'WORKSPACE_CONFIRMATION_KEY',
        'WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL',
      ])
        delete ordinaryEnv[key];
      delete process.env.WORKSPACE_MIGRATION_KEY;
      const users = [];
      for (const name of ['Composition A', 'Composition B']) {
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
        const result = await auth.handler(new Request(link));
        const cookie = result.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; ');
        users.push({ cookie, origin: 'http://localhost:5173' });
      }
      app = buildApp();
      app.log.level = 'error';
      startWorker('src/storage-worker.ts', maintenanceEnv);
      let ordinary = startWorker('src/worker.ts', ordinaryEnv);
      for (const [index, headers] of users.entries()) {
        const workspace = await request(
          'POST',
          '/v1/workspaces',
          headers,
          {
            requestId: randomUUID(),
            name: `Composition ${index}`,
            slug: `composition-${index}`,
            challengeToken: 'XXXX.DUMMY.TOKEN.XXXX',
          },
          202,
        );
        workspaces.push(workspace);
        await waitFor(
          async () => (await app.inject({ url: `/v1/workspaces/${workspace.slug}`, headers })).statusCode,
          code => code === 200,
          'Workspace readiness',
        );
      }
      const a = workspaces[0];
      const b = workspaces[1];
      const headers = users[0];
      const catalog = await request('GET', `/v1/workspaces/${a.id}/model-catalog`, headers);
      assert.equal(catalog.families.length, 13);
      assert.deepEqual(
        catalog.families.find(family => family.id === 'claude-haiku'),
        {
          id: 'claude-haiku',
          displayName: 'Claude Haiku',
          vendor: 'anthropic',
          currentVersion: 'claude-haiku-4-5',
          provider: 'anthropic',
          available: false,
          unavailableReason: 'model-family-unavailable',
          mappingRevision: null,
          pricingRevision: null,
          inputCreditsPerMillionTokens: 150,
          outputCreditsPerMillionTokens: 750,
          fallbackFor: [],
        },
      );
      await request('GET', `/v1/workspaces/${a.id}/model-catalog`, users[1], undefined, 404);
      await request('GET', `/v1/workspaces/${a.id}/model-catalog`, {}, undefined, 401);
      const team = randomUUID();
      await request('PUT', `/v1/workspaces/${a.id}/governance/teams/${team}`, headers, { name: 'Finance' });
      async function openChat(workspaceId, user) {
        const chat = randomUUID();
        await request('PUT', `/v1/workspaces/${workspaceId}/conversations/${chat}`, user, { commandId: randomUUID() });
        const sent = await request(
          'PUT',
          `/v1/workspaces/${workspaceId}/conversations/${chat}/messages/${randomUUID()}`,
          user,
          { commandId: randomUUID(), parts: [{ kind: 'text', text: 'Prepare the reviewed Invoices table changes.' }] },
        );
        return {
          workspaceId,
          user,
          base: `/v1/workspaces/${workspaceId}/conversations/${chat}/table-changes`,
          turnId: sent.turnId,
        };
      }
      async function propose(chat, plan) {
        const id = randomUUID();
        const input = { turnId: chat.turnId, input: { plans: [plan] } };
        const proposal = await request('PUT', `${chat.base}/${id}`, chat.user, input, 202);
        assert.equal(proposal.status, 'pending');
        assert.deepEqual(
          await request('PUT', `${chat.base}/${id}`, chat.user, input, 202),
          proposal,
          'Replaying one proposal identity returns the stored proposal',
        );
        return { ...proposal, chat };
      }
      async function approve(proposal) {
        const decided = await request('PUT', `${proposal.chat.base}/${proposal.id}/decision`, proposal.chat.user, {
          commandId: randomUUID(),
          digest: proposal.digest,
          decision: 'approve',
        });
        assert.equal(decided.status, 'approved');
        approved.push({ workspaceId: proposal.chat.workspaceId, id: proposal.id });
      }
      async function completed(proposal) {
        const status = await waitFor(
          () => request('GET', `${proposal.chat.base}/${proposal.id}/status`, proposal.chat.user),
          value => {
            if (['failed', 'partial', 'rejected', 'cancelled', 'expired'].includes(value.status))
              assert.fail(JSON.stringify(value));
            return value.status === 'completed';
          },
          `Proposal ${proposal.id} completed`,
        );
        return status.plans[0].receipt.revision;
      }
      const chatA = await openChat(a.id, headers);
      const tableId = randomUUID();
      const field = randomUUID();
      const base = `/v1/workspaces/${a.id}/tables/${tableId}`;
      const nameField = { id: field, label: 'Name', kind: 'text', required: false, maxLength: 1000 };
      const invoices = {
        formatVersion: 2,
        id: tableId,
        owningTeamId: team,
        label: 'Invoices',
        fields: [nameField],
        uniqueKeys: [],
      };
      const create = await propose(chatA, {
        kind: 'schema',
        tableId,
        expectedRevision: null,
        dependsOn: [],
        target: invoices,
        transforms: { outputs: [] },
      });
      const strangerDecision = await app.inject({
        method: 'PUT',
        url: `${chatA.base}/${create.id}/decision`,
        headers: users[1],
        payload: { commandId: randomUUID(), digest: create.digest, decision: 'approve' },
      });
      assert.equal(strangerDecision.statusCode, 404, strangerDecision.body);
      assert.equal(
        (
          await ownerPool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1', [
            confirmationRole,
          ])
        ).rows[0].n,
        0,
        'Unauthorized decision must not connect to the confirmation registry',
      );
      await setTimeout(3000);
      await assert.rejects(
        temporal.client.workflow.getHandle(`table-proposal-v2-${a.id}-${create.id}`).describe(),
        error => error.name === 'WorkflowNotFoundError',
        'The dispatcher waits for approval',
      );
      assert.equal((await request('GET', base, headers)).applied, null, 'A pending proposal applies nothing');
      await approve(create);
      let revision = await completed(create);
      let tableState = await request('GET', base, headers);
      assert.equal(tableState.applied.revision, revision);
      assert.deepEqual(tableState.applied.definition, invoices);
      const otherTeam = randomUUID();
      const otherTable = randomUUID();
      const otherField = randomUUID();
      await request('PUT', `/v1/workspaces/${b.id}/governance/teams/${otherTeam}`, users[1], { name: 'Finance B' });
      const chatB = await openChat(b.id, users[1]);
      const otherInvoices = {
        formatVersion: 2,
        id: otherTable,
        owningTeamId: otherTeam,
        label: 'Invoices',
        fields: [{ id: otherField, label: 'Amount', kind: 'numeric', required: true, precision: 12, scale: 2 }],
        uniqueKeys: [],
      };
      const otherCreate = await propose(chatB, {
        kind: 'schema',
        tableId: otherTable,
        expectedRevision: null,
        dependsOn: [],
        target: otherInvoices,
        transforms: { outputs: [] },
      });
      await approve(otherCreate);
      const otherRevision = await completed(otherCreate);
      const otherState = await request('GET', `/v1/workspaces/${b.id}/tables/${otherTable}`, users[1]);
      assert.deepEqual(otherState.applied.definition, otherInvoices);
      assert.equal((await app.inject({ url: `/v1/workspaces/${b.id}/tables/${otherTable}`, headers })).statusCode, 404);
      const deniedRows = await app.inject({
        url: `/v1/workspaces/${b.id}/tables/${otherTable}/rows?revision=${otherRevision}&limit=1`,
        headers,
      });
      assert.equal(deniedRows.statusCode, 404);
      assert.deepEqual(
        deniedRows.json(),
        { error: 'proposal-unavailable' },
        'storage-capacity denial probes expect this non-member response',
      );
      const restricted = workspaceRuntime(identityPool);
      try {
        await assert.rejects(
          restricted.transaction(a.id, { minimum: stream.length, maximum: stream.length }, ({ client }) =>
            client.query(`SELECT * FROM "${workspaceNames(b.id).schema}".tf_table_catalog`),
          ),
          error => error.code === '42501',
        );
      } finally {
        await restricted.close();
      }
      const rowId = randomUUID();
      const row = await request('POST', `${base}/rows`, headers, {
        requestId: randomUUID(),
        kind: 'create',
        tableId,
        revision,
        recordId: rowId,
        values: { [field]: { kind: 'text', value: 'invoice-private-value' } },
      });
      assert.deepEqual(row.values, { [field]: { kind: 'text', value: 'invoice-private-value' } });
      const recipient = await createAuth(
        identityPool,
        async () => {},
        async () => {},
      ).api.getSession({ headers: new Headers(users[1]) });
      const inviter = await createAuth(
        identityPool,
        async () => {},
        async () => {},
      ).api.getSession({ headers: new Headers(headers) });
      const memberRuntime = workspaceRuntime(identityPool);
      let businessMember;
      try {
        businessMember = await createWorkspaceMember({
          runtime: memberRuntime,
          workspace: { id: a.id, userId: inviter.user.id },
          profile: { name: recipient.user.name, contactEmail: recipient.user.email },
        });
      } finally {
        await memberRuntime.close();
      }
      const invitation = await request('POST', `/v1/workspaces/${a.id}/governance/invitations`, headers, {
        kind: 'email',
        email: recipient.user.email,
        requestId: randomUUID(),
        workspaceMemberId: businessMember.id,
      });
      const link = await request(
        'GET',
        `/v1/workspaces/${a.id}/governance/invitations/${invitation.invitation.id}/link`,
        headers,
      );
      const joined = await request('POST', '/v1/invitations/redeem', users[1], {
        token: new URL(link.url).searchParams.get('token'),
      });
      await request('PUT', `/v1/workspaces/${a.id}/governance/teams/${team}/members/${joined.membershipId}`, headers, {
        enrolled: true,
      });
      for (const permission of ['table.row.read', 'table.row.update']) {
        await request('PUT', `/v1/workspaces/${a.id}/governance/grants`, headers, {
          teamId: team,
          target: { kind: 'table', id: tableId, permission },
          granted: true,
        });
      }
      const memberUpdate = await request('POST', `${base}/rows`, users[1], {
        requestId: randomUUID(),
        kind: 'update',
        tableId,
        revision,
        recordId: rowId,
        expectedToken: row.token,
        values: { [field]: { kind: 'text', value: 'invoice-private-value' } },
      });
      assert.deepEqual(memberUpdate.values, { [field]: { kind: 'text', value: 'invoice-private-value' } });
      assert.notEqual(memberUpdate.token, row.token, 'The member update wrote the row');
      const memberProposal = await app.inject({
        method: 'PUT',
        url: `${chatA.base}/${randomUUID()}`,
        headers: users[1],
        payload: {
          turnId: chatA.turnId,
          input: {
            plans: [
              {
                kind: 'schema',
                tableId,
                expectedRevision: revision,
                dependsOn: [],
                target: { ...invoices, label: 'Forbidden' },
                transforms: { outputs: [] },
              },
            ],
          },
        },
      });
      assert.equal(memberProposal.statusCode, 404, memberProposal.body);
      const memberChat = await openChat(a.id, users[1]);
      const memberSchema = await app.inject({
        method: 'PUT',
        url: `${memberChat.base}/${randomUUID()}`,
        headers: users[1],
        payload: {
          turnId: memberChat.turnId,
          input: {
            plans: [
              {
                kind: 'schema',
                tableId,
                expectedRevision: revision,
                dependsOn: [],
                target: { ...invoices, label: 'Forbidden' },
                transforms: { outputs: [] },
              },
            ],
          },
        },
      });
      assert.equal(memberSchema.statusCode, 404, memberSchema.body);
      assert.deepEqual(
        memberSchema.json(),
        { error: 'proposal-unavailable' },
        'Row grants do not allow schema changes',
      );
      const exited = new Promise(resolve => ordinary.once('exit', resolve));
      ordinary.kill('SIGKILL');
      await exited;
      workers.splice(workers.indexOf(ordinary), 1);
      const extra = randomUUID();
      const memo = { id: extra, label: 'Memo', kind: 'text', required: true, maxLength: 1000 };
      const backfill = await propose(chatA, {
        kind: 'schema',
        tableId,
        expectedRevision: revision,
        dependsOn: [],
        target: { ...invoices, fields: [nameField, memo] },
        transforms: {
          outputs: [
            {
              fieldId: extra,
              expression: { op: 'literal', value: { kind: 'text', value: 'backfilled-private-value' } },
            },
          ],
        },
      });
      await approve(backfill);
      await app.close();
      app = buildApp();
      app.log.level = 'error';
      await app.ready();
      await setTimeout(3000);
      assert.equal(
        (await request('GET', `${chatA.base}/${backfill.id}/status`, headers)).status,
        'approved',
        'Execution waits for an ordinary worker',
      );
      ordinary = startWorker('src/worker.ts', ordinaryEnv);
      revision = await completed(backfill);
      const backfilledRow = {
        [field]: { kind: 'text', value: 'invoice-private-value' },
        [extra]: { kind: 'text', value: 'backfilled-private-value' },
      };
      assert.deepEqual(
        (await request('GET', `${base}/rows?revision=${revision}`, headers)).find(row => row.id === rowId).values,
        backfilledRow,
      );
      const drop = await propose(chatA, {
        kind: 'schema',
        tableId,
        expectedRevision: revision,
        dependsOn: [],
        target: invoices,
        transforms: { outputs: [] },
      });
      const memberDecision = await app.inject({
        method: 'PUT',
        url: `${chatA.base}/${drop.id}/decision`,
        headers: users[1],
        payload: { commandId: randomUUID(), digest: drop.digest, decision: 'approve' },
      });
      assert.equal(memberDecision.statusCode, 404, 'Only the requester decides a proposal, even for a granted member');
      assert.equal(
        (
          await ownerPool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1', [
            confirmationRole,
          ])
        ).rows[0].n,
        0,
        'Unauthorized decision must not connect to the confirmation registry',
      );
      await setTimeout(3000);
      assert.deepEqual(
        (await request('GET', `${base}/rows?revision=${revision}`, headers)).find(row => row.id === rowId).values,
        backfilledRow,
        'An unapproved drop removes nothing',
      );
      await approve(drop);
      revision = await completed(drop);
      assert.deepEqual(
        (await request('GET', `${base}/rows?revision=${revision}`, headers)).find(row => row.id === rowId).values,
        { [field]: { kind: 'text', value: 'invoice-private-value' } },
      );
      tableState = await request('GET', base, headers);
      assert.deepEqual(tableState.applied.definition, invoices);
      const schemaHistory = (await request('GET', `${base}/schema-history`, headers)).entries;
      assert.deepEqual(
        schemaHistory.map(entry => [entry.phase, entry.definition.fields.length, entry.savedAt !== null]).sort(),
        [
          ['completed', 1, true],
          ['completed', 1, true],
          ['completed', 2, true],
        ],
      );
      await assert.rejects(
        identityPool.query('SELECT confirmation_credential FROM app.workspace_storage'),
        error => error.code === '42501',
      );
      await assert.rejects(
        identityPool.query('SELECT migration_credential FROM app.workspace_storage'),
        error => error.code === '42501',
      );
      const registry = new Pool({ connectionString: registryURLs.confirmation });
      try {
        await assert.rejects(
          registry.query('SELECT migration_credential FROM app.workspace_storage'),
          error => error.code === '42501',
        );
      } finally {
        await registry.end();
      }
      for (const proposal of approved) {
        const history = await temporal.client.workflow
          .getHandle(`table-proposal-v2-${proposal.workspaceId}-${proposal.id}`)
          .fetchHistory();
        const text = JSON.stringify(history);
        for (const secret of [
          'invoice-private-value',
          'backfilled-private-value',
          password,
          process.env.WORKSPACE_RUNTIME_KEY,
          process.env.WORKSPACE_CONFIRMATION_KEY,
        ])
          assert.equal(text.includes(secret), false);
        const input = history.events.find(event => event.workflowExecutionStartedEventAttributes)
          ?.workflowExecutionStartedEventAttributes.input.payloads;
        assert.deepEqual(
          input.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
          [proposal.workspaceId, proposal.id, process.env.TEMPORAL_STORAGE_TASK_QUEUE],
        );
      }
      assert.deepEqual(
        (
          await ownerPool.query(`SELECT name FROM "${workspaceNames(a.id).schema}".tf_common_migrations ORDER BY name`)
        ).rows.map(row => row.name),
        stream.map(migration => migration.name),
      );
    } finally {
      await app?.close();
      for (const worker of workers)
        if (worker.exitCode === null && worker.signalCode === null) {
          const exited = new Promise(resolve => worker.once('exit', resolve));
          worker.kill('SIGTERM');
          await Promise.race([exited, setTimeout(10000)]);
          if (worker.exitCode === null && worker.signalCode === null) {
            worker.kill('SIGKILL');
            await exited;
          }
        }
      for (const workspace of workspaces) {
        const prefix = `workspaces/${workspace.id}/soul/`;
        const objects = await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix }));
        if (objects.Contents?.length)
          await storage.client.send(
            new DeleteObjectsCommand({
              Bucket: storage.bucket,
              Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
            }),
          );
      }
      await temporal.connection.close();
      storage.client.destroy();
      await ownerPool.end();
      await identityPool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)} WITH (FORCE)`);
      for (const workspace of workspaces)
        for (const capability of ['runtime', 'migration', 'confirmation', 'customOwner'])
          await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(workspaceNames(workspace.id)[capability])}`);
      for (const role of [...registries, identity, owner])
        await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      await admin.end();
      for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
      Object.assign(process.env, oldEnv);
    }
  },
);
import { provisionTestPgvector } from '../../../packages/workspace-storage/test/integration/pgvector.fixture.mjs';
