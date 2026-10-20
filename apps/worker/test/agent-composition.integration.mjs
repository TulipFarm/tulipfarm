import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { workspaceNames } from '../../../packages/workspace-storage/dist/runtime.js';
import { AccessDenied } from '../../../packages/access/dist/index.js';
import { createAgentComposition } from '../dist/agent-composition.js';
import { createAuth } from '../../api/dist/auth.js';
import { buildApp } from '../../api/dist/app.js';
import { createTemporalClient } from '../../api/dist/temporal.js';
import {
  createTableWithRows,
  createWorkspaceMember,
  tableDefinition,
  textField,
  textValues,
} from '../../../packages/tables/test/fixture.mjs';
import { readMigrations } from '../../database/src/migrations.ts';

function payloadText(value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(payloadText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(payloadText).join('\n');
  return typeof value === 'string' ? value : '';
}

test(
  'production worker executes persisted bounded calls through dispatched authoring and maintenance',
  { timeout: 240000 },
  async t => {
    const storage = soulStorageConfig();
    assert.equal(storage.bucket, 'tulipfarm-cloud-soul-local');
    const oldEnv = { ...process.env };
    const token = randomUUID().replaceAll('-', '');
    const database = `agent_composition_${token}`;
    const owner = `ac_owner_${token}`;
    const identity = `ac_identity_${token}`;
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
    const workers = new Set();
    const handles = [];
    let workspace;
    let runtime;
    let app;
    let workerOutput = '';
    const privateValue = 'agent-production-record-private';
    const instructions = 'agent-production-instructions-private';
    const integrationPrivateValues = [];
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return originalFetch(url, options);
      assert.equal(options.body.get('response'), 'XXXX.DUMMY.TOKEN.XXXX');
      return Response.json({ success: true, metadata: { result_with_testing_key: true } });
    });
    async function eventually(read, accepts, description) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const value = await read();
        if (accepts(value)) return value;
        for (const worker of workers)
          assert.ok(worker.exitCode === null && worker.signalCode === null, 'Worker exited before completion');
        await setTimeout(150);
      }
      assert.fail(description);
    }
    function startWorker(entry, env) {
      const worker = spawn(process.execPath, [entry], {
        cwd: new URL('..', import.meta.url),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      worker.stdout.on('data', data => {
        workerOutput += data.toString();
      });
      worker.stderr.on('data', data => {
        workerOutput += data.toString();
      });
      workers.add(worker);
      return worker;
    }
    async function stopWorker(worker, signal = 'SIGTERM') {
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = new Promise(resolve => worker.once('exit', resolve));
        worker.kill(signal);
        await Promise.race([exited, setTimeout(10000)]);
        if (worker.exitCode === null && worker.signalCode === null) {
          worker.kill('SIGKILL');
          await exited;
        }
      }
      workers.delete(worker);
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
      for (const capability of ['authoring', 'confirmation', 'migration']) {
        const role = `ac_${capability}_${token}`;
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
      process.env.TEMPORAL_TASK_QUEUE = `agent-composition-${token}`;
      process.env.TEMPORAL_STORAGE_TASK_QUEUE = `agent-maintenance-${token}`;
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
        'WORKSPACE_PROVISIONING_DATABASE_URL',
        'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
        'WORKSPACE_MIGRATION_KEY',
        'WORKSPACE_CONFIRMATION_KEY',
        'WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL',
        'WORKSPACE_MIGRATION_PREVIOUS_KEYS',
        'WORKSPACE_CONFIRMATION_PREVIOUS_KEYS',
      ])
        delete ordinaryEnv[key];
      delete process.env.WORKSPACE_MIGRATION_KEY;
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
        body: { email: `${randomUUID()}@example.com`, name: 'Agent operator' },
      });
      const login = await auth.handler(new Request(link));
      const headers = {
        cookie: login.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; '),
        origin: 'http://localhost:5173',
      };
      const session = await auth.api.getSession({ headers: new Headers(headers) });
      assert.ok(session?.user.id);
      if (process.env.AGENT_TEST_USE_LOCAL_WRITER_FOR_READS === '1') {
        process.env.R2_SOUL_READ_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
        process.env.R2_SOUL_READ_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
      }
      const reader = soulStorageConfig('read');
      assert.equal(reader.bucket, 'tulipfarm-cloud-soul-local');
      reader.client.destroy();
      app = buildApp();
      app.log.level = 'silent';
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      async function httpRequest(method, url, payload, requestHeaders = headers) {
        const response = await fetch(new URL(url, address), {
          method,
          redirect: 'error',
          headers: { ...requestHeaders, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        assert.equal(response.status, 200, `${method} ${url} failed; response suppressed`);
        return response.json().catch(() => {
          throw new Error('Invalid HTTP JSON; response suppressed');
        });
      }
      const openapi = await httpRequest('GET', '/v1/docs/json');
      assert.equal(openapi.paths['/v1/workspaces/{workspaceId}/integrations'].post.operationId, 'createIntegrationV1');
      assert.equal(
        openapi.paths['/v1/workspaces/{workspaceId}/integrations/read-issue'].post.operationId,
        'readIntegrationIssueV1',
      );
      async function request(method, url, payload, status = 200, requestHeaders = headers) {
        const response = await app.inject({
          method,
          url,
          headers: requestHeaders,
          ...(payload === undefined ? {} : { payload }),
        });
        assert.equal(response.statusCode, status, response.body);
        return response.json();
      }
      startWorker('dist/storage-worker.js', maintenanceEnv);
      let ordinary = startWorker('dist/worker.js', ordinaryEnv);
      workspace = await request(
        'POST',
        '/v1/workspaces',
        {
          requestId: randomUUID(),
          name: 'Agent composition',
          slug: `agent-${token}`,
          challengeToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        202,
      );
      await eventually(
        async () => (await app.inject({ url: `/v1/workspaces/${workspace.slug}`, headers })).statusCode,
        value => value === 200,
        'Workspace was not provisioned',
      );
      const schema = workspaceNames(workspace.id).schema;
      runtime = workspaceRuntime(identityPool);
      const agent = createAgentComposition(runtime);
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: 'http://localhost:5173' }),
        body: { email: `${randomUUID()}@example.com`, name: 'Agent member' },
      });
      const memberLogin = await auth.handler(new Request(link));
      const memberHeaders = {
        ...headers,
        cookie: memberLogin.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; '),
      };
      const memberSession = await auth.api.getSession({ headers: new Headers(memberHeaders) });
      assert.ok(memberSession?.user.id);
      const governance = `/v1/workspaces/${workspace.id}/governance`;
      const businessMember = await createWorkspaceMember({
        runtime,
        workspace: { id: workspace.id, userId: session.user.id },
        profile: { name: 'Agent member', contactEmail: memberSession.user.email },
      });
      const invitation = await request('POST', `${governance}/invitations`, {
        kind: 'email',
        email: memberSession.user.email,
        requestId: randomUUID(),
        workspaceMemberId: businessMember.id,
      });
      const invitationLink = await request('GET', `${governance}/invitations/${invitation.invitation.id}/link`);
      const joined = await request(
        'POST',
        '/v1/invitations/redeem',
        { token: new URL(invitationLink.url).searchParams.get('token') },
        200,
        memberHeaders,
      );
      const actor = { kind: 'human', userId: memberSession.user.id, membershipId: joined.membershipId };
      const membership = (await request('GET', governance)).members.find(member => member.id === actor.membershipId);
      assert.equal(membership.role, 'member');
      const teamId = randomUUID();
      const tableId = randomUUID();
      const agentId = randomUUID();
      await request('PUT', `/v1/workspaces/${workspace.id}/governance/teams/${teamId}`, { name: 'Agent team' });
      await request('PUT', `${governance}/teams/${teamId}/members/${actor.membershipId}`, { enrolled: true });
      const permissions = ['table.schema.manage', 'table.row.create', 'table.row.read'];
      await request('PUT', `/v1/workspaces/${workspace.id}/governance/grants`, {
        teamId,
        target: { kind: 'collection', id: teamId, permission: 'table.create' },
        granted: true,
      });
      const scope = [
        { assetId: teamId, permissions: ['table.create'] },
        { assetId: tableId, permissions },
      ];
      const agents = `/v1/workspaces/${workspace.id}/agents`;
      await request('PUT', `${governance}/teams/${teamId}/members/${actor.membershipId}/role`, { role: 'manager' });
      const authoringContext = await request('GET', `${agents}/authoring-context`, undefined, 200, memberHeaders);
      assert.equal('admin' in authoringContext, false);
      const definition = { name: 'Bounded operator', instructions, tools: ['tables.list', 'rows.list'] };
      const save = await request(
        'PUT',
        `${agents}/${agentId}`,
        {
          requestId: randomUUID(),
          expectedSoulRevision: authoringContext.currentSoulRevision,
          expectedSavedRevision: null,
          owningTeamId: teamId,
          definition,
        },
        200,
        memberHeaders,
      );
      assert.equal(save.status, 'preparing');
      const accepted = await eventually(
        () => request('GET', `${agents}/commands/${save.commandId}`, undefined, 200, memberHeaders),
        value => value.status !== 'preparing',
        'Agent definition was not prepared',
      );
      assert.equal(accepted.status, 'accepted');
      await request(
        'PUT',
        `${agents}/${agentId}/policy`,
        {
          version: 0,
          owningTeamId: teamId,
          grants: [],
          personGrants: [{ membershipId: actor.membershipId, permissions: ['manage'] }],
        },
        404,
      );
      await request(
        'PUT',
        `${agents}/${agentId}/policy`,
        {
          version: 0,
          owningTeamId: teamId,
          grants: [{ teamId, permissions: ['read', 'invoke'] }],
          personGrants: [
            { membershipId: actor.membershipId, permissions: ['delete', 'edit', 'invoke', 'manage', 'read'] },
          ],
        },
        200,
        memberHeaders,
      );
      const saved = await request('GET', `${agents}/${agentId}`, undefined, 200, memberHeaders);
      assert.deepEqual(saved.definition, definition);
      assert.equal(saved.savedRevision, accepted.savedRevision);
      assert.ok(saved.capabilities.includes('manage'));
      const activation = await request(
        'POST',
        `${agents}/${agentId}/activations`,
        { revision: saved.definitionRevision, scope },
        200,
        memberHeaders,
      );
      await request(
        'PUT',
        `${agents}/${agentId}/enrollment`,
        {
          version: (await request('GET', `${agents}/${agentId}/policy`, undefined, 200, memberHeaders)).version,
          enabled: true,
          teamIds: [teamId],
          limits: scope,
        },
        200,
        memberHeaders,
      );
      const run = await agent.startDelegated(workspace.id, actor, { activationId: activation.activationId, scope });
      assert.equal(run.revision, saved.definitionRevision);
      async function dispatch(ids) {
        const handle = await temporal.client.workflow.start('boundedAgentTool', {
          workflowId: `agent-tool-${ids.callId}`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE,
          args: [ids],
        });
        handles.push({ handle, ids });
        return { handle, ids };
      }
      async function startCall(sequence, call, runId = run.runId, human = actor) {
        const ids = { workspaceId: workspace.id, runId, callId: randomUUID() };
        await agent.queueCall(workspace.id, human, { runId, callId: ids.callId, sequence, call });
        return dispatch(ids);
      }
      async function result(call, status = 'completed') {
        assert.equal(await call.handle.result(), status);
        return agent.readResult(call.ids, actor);
      }
      const githubToken = await new Promise((resolve, reject) => {
        const env = Object.fromEntries(
          ['PATH', 'HOME', 'GH_CONFIG_DIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]),
        );
        execFile(
          'gh',
          ['auth', 'token', '--hostname', 'github.com'],
          { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            if (error) reject(new Error('GitHub credential unavailable; details suppressed'));
            else resolve(stdout.trim());
          },
        );
      });
      assert.ok(githubToken.length > 0, 'GitHub credential unavailable');
      integrationPrivateValues.push(githubToken, process.env.INTEGRATION_CREDENTIAL_KEY);
      const integrationId = randomUUID();
      const sourceId = randomUUID();
      const integrationAgentId = randomUUID();
      const integrations = `/v1/workspaces/${workspace.id}/integrations`;
      const integration = await httpRequest('POST', integrations, {
        id: integrationId,
        name: 'Production issue reader',
        owningTeamId: teamId,
        token: githubToken,
        repositories: [{ id: sourceId, owner: 'TulipFarm', repo: 'tulipfarm-cloud' }],
      });
      assert.equal(integration.generation, 1);
      assert.equal(
        JSON.stringify(integration).includes(githubToken),
        false,
        'Credential disclosed by integration creation',
      );
      const encrypted = (
        await ownerPool.query(`SELECT credential FROM "${schema}".tf_integrations WHERE id = $1`, [integrationId])
      ).rows[0].credential;
      assert.ok(
        typeof encrypted.ciphertext === 'string' && encrypted.ciphertext.length > 0,
        'Encrypted credential missing',
      );
      assert.equal(JSON.stringify(encrypted).includes(githubToken), false, 'Credential stored in plaintext');
      await httpRequest('PUT', `${integrations}/${integrationId}/grants`, {
        expectedGrantsVersion: 1,
        grants: [{ teamId, permissions: ['read', 'use'] }],
        sourceGrants: [{ teamId, sourceId }],
      });
      const integrationAccess = await httpRequest('GET', `${integrations}/${integrationId}`, undefined, memberHeaders);
      assert.deepEqual(integrationAccess.capabilities, { read: true, use: true, manage: false, administer: false });
      assert.deepEqual(integrationAccess.repositories, [
        { id: sourceId, owner: 'TulipFarm', repo: 'tulipfarm-cloud', canReadIssues: true },
      ]);
      const integrationScope = [
        { assetId: integrationId, permissions: ['integration.read', 'integration.use'] },
        { assetId: sourceId, permissions: ['github.issue.read'] },
      ];
      const integrationDefinition = {
        name: 'Saved issue reader',
        instructions: 'production-integration-instructions-private',
        tools: ['github.issue.read'],
      };
      integrationPrivateValues.push(integrationDefinition.instructions);
      const integrationContext = await httpRequest('GET', `${agents}/authoring-context`, undefined, memberHeaders);
      const integrationSave = await httpRequest(
        'PUT',
        `${agents}/${integrationAgentId}`,
        {
          requestId: randomUUID(),
          expectedSoulRevision: integrationContext.currentSoulRevision,
          expectedSavedRevision: null,
          owningTeamId: teamId,
          definition: integrationDefinition,
        },
        memberHeaders,
      );
      assert.equal(integrationSave.status, 'preparing');
      const integrationAccepted = await eventually(
        () => httpRequest('GET', `${agents}/commands/${integrationSave.commandId}`, undefined, memberHeaders),
        value => value.status !== 'preparing',
        'Integration agent definition was not prepared',
      );
      assert.equal(integrationAccepted.status, 'accepted');
      const integrationManager = [{ membershipId: actor.membershipId, permissions: ['manage', 'read'] }];
      await httpRequest(
        'PUT',
        `${agents}/${integrationAgentId}/policy`,
        {
          version: 0,
          owningTeamId: teamId,
          grants: [{ teamId, permissions: ['read', 'invoke'] }],
          personGrants: integrationManager,
        },
        memberHeaders,
      );
      const integrationSaved = await httpRequest('GET', `${agents}/${integrationAgentId}`, undefined, memberHeaders);
      assert.ok(
        JSON.stringify(integrationSaved.definition) === JSON.stringify(integrationDefinition),
        'Saved integration definition differs',
      );
      assert.equal(integrationSaved.savedRevision, integrationAccepted.savedRevision);
      const integrationActivation = await httpRequest(
        'POST',
        `${agents}/${integrationAgentId}/activations`,
        { revision: integrationSaved.definitionRevision, scope: integrationScope },
        memberHeaders,
      );
      await httpRequest(
        'PUT',
        `${agents}/${integrationAgentId}/enrollment`,
        {
          version: (await httpRequest('GET', `${agents}/${integrationAgentId}/policy`, undefined, memberHeaders))
            .version,
          enabled: true,
          teamIds: [teamId],
          limits: integrationScope,
        },
        memberHeaders,
      );
      const integrationRun = await agent.startDelegated(workspace.id, actor, {
        activationId: integrationActivation.activationId,
        scope: integrationScope,
      });
      assert.equal(integrationRun.revision, integrationSaved.definitionRevision);
      const issueCall = { tool: 'github.issue.read', integrationId, sourceId, issueNumber: 5 };
      const issueRead = await startCall(0, issueCall, integrationRun.runId);
      const issueResult = await result(issueRead);
      assert.equal(issueResult.status, 'completed');
      assert.deepEqual(Object.keys(issueResult.result).sort(), ['body', 'number', 'state', 'title', 'url']);
      assert.equal(issueResult.result.number, 5);
      assert.equal(issueResult.result.url, 'https://github.com/TulipFarm/tulipfarm-cloud/issues/5');
      assert.ok(['open', 'closed'].includes(issueResult.result.state), 'Unexpected issue state');
      assert.ok(
        typeof issueResult.result.title === 'string' && issueResult.result.title.length > 0,
        'Issue title missing',
      );
      assert.equal(typeof issueResult.result.body, 'string');
      integrationPrivateValues.push(issueResult.result.title, issueResult.result.body);
      const integrationSchedule = await agent.authorizeSchedule(workspace.id, actor, {
        activationId: integrationActivation.activationId,
        scope: integrationScope,
      });
      const scheduledRun = await agent.startScheduled(workspace.id, {
        scheduleId: integrationSchedule.scheduleId,
        runId: randomUUID(),
      });
      assert.equal(scheduledRun.revision, integrationSaved.definitionRevision);
      const scheduledRead = await startCall(0, issueCall, scheduledRun.runId);
      assert.equal(await scheduledRead.handle.result(), 'completed');
      const scheduledResult = await agent.readResult(scheduledRead.ids, actor);
      assert.ok(JSON.stringify(scheduledResult) === JSON.stringify(issueResult), 'Scheduled issue result differs');
      const pendingIssueIds = { workspaceId: workspace.id, runId: integrationRun.runId, callId: randomUUID() };
      await agent.queueCall(workspace.id, actor, {
        runId: integrationRun.runId,
        callId: pendingIssueIds.callId,
        sequence: 1,
        call: issueCall,
      });
      const integrationGrants = await httpRequest('GET', `${integrations}/${integrationId}`);
      const dispatches = (
        await ownerPool.query(
          `SELECT request_id, status, attempt FROM "${schema}".tf_integration_dispatches WHERE integration_id = $1 ORDER BY request_id`,
          [integrationId],
        )
      ).rows;
      assert.deepEqual(
        dispatches,
        [issueRead.ids.callId, scheduledRead.ids.callId]
          .sort()
          .map(request_id => ({ request_id, status: 'completed', attempt: 1 })),
      );
      await httpRequest(
        'PUT',
        `${agents}/${integrationAgentId}/policy`,
        {
          version: (await httpRequest('GET', `${agents}/${integrationAgentId}/policy`, undefined, memberHeaders))
            .version,
          owningTeamId: teamId,
          grants: [{ teamId, permissions: ['read'] }],
          personGrants: integrationManager,
        },
        memberHeaders,
      );
      assert.ok(
        JSON.stringify(await httpRequest('GET', `${integrations}/${integrationId}`)) ===
          JSON.stringify(integrationGrants),
        'Integration grants changed on invoke revocation',
      );
      assert.ok(
        JSON.stringify(await httpRequest('GET', `${integrations}/${integrationId}`, undefined, memberHeaders)) ===
          JSON.stringify(integrationAccess),
        'Member source access changed on invoke revocation',
      );
      const integrationRetained = await httpRequest('GET', `${agents}/${integrationAgentId}`, undefined, memberHeaders);
      assert.ok(
        JSON.stringify(integrationRetained.definition) === JSON.stringify(integrationDefinition),
        'Definition changed on invoke revocation',
      );
      assert.deepEqual(integrationRetained.activations, [
        {
          id: integrationActivation.activationId,
          revision: integrationSaved.definitionRevision,
          scope: integrationScope,
        },
      ]);
      await assert.rejects(
        agent.startDelegated(workspace.id, actor, {
          activationId: integrationActivation.activationId,
          scope: integrationScope,
        }),
        AccessDenied,
      );
      await assert.rejects(agent.readResult(issueRead.ids, actor), AccessDenied);
      const blockedIssue = await dispatch(pendingIssueIds);
      assert.equal(await blockedIssue.handle.result(), 'blocked');
      await assert.rejects(agent.readResult(blockedIssue.ids, actor), AccessDenied);
      assert.deepEqual(
        (
          await ownerPool.query(`SELECT status, result FROM "${schema}".tf_agent_tool_calls WHERE id = $1`, [
            pendingIssueIds.callId,
          ])
        ).rows,
        [{ status: 'blocked', result: { code: 'access-denied' } }],
      );
      assert.deepEqual(
        (
          await ownerPool.query(
            `SELECT request_id, status, attempt FROM "${schema}".tf_integration_dispatches WHERE integration_id = $1 ORDER BY request_id`,
            [integrationId],
          )
        ).rows,
        dispatches,
      );
      const persistedIntegrations = JSON.stringify(
        (
          await ownerPool.query(`SELECT row_to_json(c) FROM "${schema}".tf_integrations c
      UNION ALL SELECT row_to_json(d) FROM "${schema}".tf_integration_dispatches d
      UNION ALL SELECT row_to_json(t) FROM "${schema}".tf_agent_tool_calls t
      UNION ALL SELECT row_to_json(a) FROM "${schema}".tf_audit_events a`)
        ).rows,
      );
      for (const value of [githubToken, process.env.INTEGRATION_CREDENTIAL_KEY]) {
        assert.equal(
          persistedIntegrations.includes(value),
          false,
          'Credential disclosed in persisted integration data',
        );
        assert.equal(
          persistedIntegrations.includes(Buffer.from(value).toString('base64')),
          false,
          'Encoded credential disclosed in persisted integration data',
        );
      }
      const field = textField('Private name');
      const created = await createTableWithRows({
        db: { login: () => ownerURL },
        workspace: { id: workspace.id, userId: session.user.id, names: workspaceNames(workspace.id) },
        runtime,
        definition: tableDefinition({ owningTeamId: teamId, id: tableId, label: 'Agent invoices', fields: [field] }),
        records: [{ values: textValues(field, privateValue) }],
      });
      for (const permission of permissions)
        await request('PUT', `/v1/workspaces/${workspace.id}/governance/grants`, {
          teamId,
          target: { kind: 'table', id: tableId, permission },
          granted: true,
        });
      const listed = await startCall(0, {
        tool: 'rows.list',
        tableId,
        expectedAppliedRevision: created.revision,
        query: { limit: 10 },
      });
      assert.ok(JSON.stringify(await result(listed)).includes(privateValue), 'Agent did not read the record');
      await assert.rejects(
        agent.queueCall(workspace.id, actor, {
          runId: run.runId,
          callId: randomUUID(),
          sequence: 1,
          call: { tool: 'sql', query: 'DROP SCHEMA app' },
        }),
      );
      await assert.rejects(
        agent.queueCall(workspace.id, actor, {
          runId: run.runId,
          callId: randomUUID(),
          sequence: 1,
          call: { tool: 'schema.save', tableId },
        }),
      );
      await assert.rejects(
        agent.queueCall(workspace.id, actor, {
          runId: run.runId,
          callId: randomUUID(),
          sequence: 1,
          role: 'admin',
          call: { tool: 'rows.list', tableId, expectedAppliedRevision: created.revision, query: { limit: 1 } },
        }),
      );
      const retainedGovernance = await request('GET', governance);
      const retainedManager = [{ membershipId: actor.membershipId, permissions: ['delete', 'edit', 'manage', 'read'] }];
      await request(
        'PUT',
        `${agents}/${agentId}/policy`,
        {
          version: (await request('GET', `${agents}/${agentId}/policy`, undefined, 200, memberHeaders)).version,
          owningTeamId: teamId,
          grants: [{ teamId, permissions: ['read'] }],
          personGrants: retainedManager,
        },
        200,
        memberHeaders,
      );
      const retained = await request('GET', `${agents}/${agentId}`, undefined, 200, memberHeaders);
      assert.deepEqual(retained.definition, definition);
      assert.deepEqual(retained.activations, [
        { id: activation.activationId, revision: saved.definitionRevision, scope },
      ]);
      assert.deepEqual(await request('GET', governance), retainedGovernance);
      assert.deepEqual(await request('GET', `${agents}/${agentId}/policy`, undefined, 200, memberHeaders), {
        version: 3,
        owningTeamId: teamId,
        grants: [{ teamId, permissions: ['read'] }],
        personGrants: retainedManager,
        enrollment: [teamId],
        enabled: true,
        limits: scope,
      });
      await assert.rejects(
        agent.startDelegated(workspace.id, actor, { activationId: activation.activationId, scope }),
        AccessDenied,
      );
      await assert.rejects(agent.readResult(listed.ids, actor), AccessDenied);
      const fakeIds = { workspaceId: workspace.id, runId: randomUUID(), callId: randomUUID() };
      const fake = await temporal.client.workflow.start('boundedAgentTool', {
        workflowId: `agent-forged-${token}`,
        taskQueue: process.env.TEMPORAL_TASK_QUEUE,
        args: [fakeIds],
      });
      handles.push({ handle: fake, ids: fakeIds });
      assert.equal(await fake.result(), 'blocked');
      assert.deepEqual(
        (await ownerPool.query(`SELECT name FROM "${schema}".tf_common_migrations ORDER BY name`)).rows.map(
          row => row.name,
        ),
        (await workspaceTableMigrations()).map(migration => migration.name),
      );
      const authoringPool = new Pool({ connectionString: registryURLs.authoring });
      try {
        for (const column of ['migration_credential', 'confirmation_credential'])
          await assert.rejects(
            authoringPool.query(`SELECT ${column} FROM app.workspace_storage`),
            error => error.code === '42501',
          );
      } finally {
        await authoringPool.end();
      }
      await assert.rejects(
        runtime.transaction(workspace.id, commonCompatibility, ({ client }) =>
          client.query(`CREATE TABLE "${schema}".forbidden (id int)`),
        ),
        error => error.code === '42501',
      );
      const histories = [];
      for (const { handle, ids } of handles) {
        const history = await handle.fetchHistory();
        histories.push(history);
        const input = history.events.find(event => event.workflowExecutionStartedEventAttributes)
          .workflowExecutionStartedEventAttributes.input.payloads;
        assert.deepEqual(
          input.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
          [ids],
        );
        for (const event of history.events) {
          const activity = event.activityTaskScheduledEventAttributes;
          if (activity) {
            assert.equal(activity.activityType.name, 'executeAgentTool');
            assert.deepEqual(
              activity.input.payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
              [ids],
            );
          }
          const completed =
            event.activityTaskCompletedEventAttributes?.result?.payloads ??
            event.workflowExecutionCompletedEventAttributes?.result?.payloads;
          if (completed)
            assert.ok(
              completed.every(payload =>
                ['completed', 'waiting', 'blocked'].includes(JSON.parse(Buffer.from(payload.data).toString())),
              ),
              'Tool history result was not status only',
            );
        }
      }
      for (const savedCommand of [save, integrationSave]) {
        const saveHandle = temporal.client.workflow.getHandle(
          `agent-save-v1-${workspace.id}-${savedCommand.commandId}`,
        );
        assert.equal(await saveHandle.result(), 'accepted');
        const saveHistory = await saveHandle.fetchHistory();
        histories.push(saveHistory);
        const saveStarted = saveHistory.events.find(
          event => event.workflowExecutionStartedEventAttributes,
        ).workflowExecutionStartedEventAttributes;
        assert.equal(saveStarted.workflowType.name, 'prepareAgentSave');
        assert.deepEqual(
          saveStarted.input.payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
          [workspace.id, savedCommand.commandId],
        );
        const preparations = saveHistory.events
          .filter(event => event.activityTaskScheduledEventAttributes)
          .map(event => event.activityTaskScheduledEventAttributes);
        assert.ok(preparations.length > 0);
        for (const activity of preparations) {
          assert.equal(activity.activityType.name, 'prepareAgentDefinition');
          assert.deepEqual(
            activity.input.payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
            [workspace.id, savedCommand.commandId],
          );
        }
      }
      await stopWorker(ordinary);
      const historyText = payloadText(histories);
      for (const value of [
        privateValue,
        instructions,
        password,
        ...integrationPrivateValues,
        ...['RUNTIME', 'MIGRATION', 'CONFIRMATION'].map(capability => maintenanceEnv[`WORKSPACE_${capability}_KEY`]),
        oldEnv.R2_ACCESS_KEY_ID,
        oldEnv.R2_SECRET_ACCESS_KEY,
      ].filter(Boolean)) {
        for (const text of [historyText, JSON.stringify(histories), workerOutput]) {
          assert.equal(text.includes(value), false, 'Private value leaked into history or worker output');
          assert.equal(
            text.includes(Buffer.from(value).toString('base64')),
            false,
            'Encoded private value leaked into history or worker output',
          );
          assert.equal(
            text.includes(JSON.stringify(value).slice(1, -1)),
            false,
            'Escaped private value leaked into history or worker output',
          );
        }
      }
    } finally {
      for (const { handle } of handles)
        if ((await handle.describe()).status.name === 'RUNNING') await handle.terminate('Disposable test cleanup');
      await app?.close();
      for (const worker of workers) await stopWorker(worker);
      await runtime?.close();
      await temporal.connection.close();
      if (workspace) {
        const objects = await storage.client.send(
          new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: `workspaces/${workspace.id}/soul/` }),
        );
        if (objects.Contents?.length)
          await storage.client.send(
            new DeleteObjectsCommand({
              Bucket: storage.bucket,
              Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
            }),
          );
      }
      storage.client.destroy();
      await ownerPool.end();
      await identityPool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)} WITH (FORCE)`);
      if (workspace)
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
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
