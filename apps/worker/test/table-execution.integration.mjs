import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { S3Client } from '../../../packages/workspaces/node_modules/@aws-sdk/client-s3/dist-cjs/index.js';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { Pool } from 'pg';
import { NativeConnection, Worker } from '@temporalio/worker';
import { fixture, loadPlatformBaseline } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { requireTableSources, requireTableFiles, requireTableImportReference } from '@tulipfarm/agents/table-sources';
import { tableProposalOptions } from '@tulipfarm/agents/table-proposals';
import { createTableExecution, createTablePublication } from '@tulipfarm/tables/execution';
import { initializeSoul } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision, readVerifiedProjection } from '@tulipfarm/workspaces/soul-revisions';
import { createAuth } from '../../api/dist/auth.js';
import { registerTableChanges } from '../../api/dist/table-changes.js';
import { registerTableDispatch } from '../../api/dist/table-dispatch.js';
import { createTemporalClient } from '../../api/dist/temporal.js';
import { registerFilesComposition } from '../../api/dist/files-composition.js';
import { filesObjectFixture } from '../../../packages/workspaces/test/files-object-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { importObjectFixture } from '../../../packages/tables/test/import-object-fixture.mjs';
import { createConversations } from '@tulipfarm/conversations';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import { registerConversations } from '../../api/dist/conversations.js';
import { createConversationActivities } from '../src/conversation-activities.ts';
import {
  completionReply,
  isCompletionRequest,
  anthropicChat,
  anthropicText,
  isTitleRequest,
  toolResults,
} from './native-chat-fixture.mjs';
import { useModelCatalog } from './model-catalog-fixture.mjs';

test(
  'Q29 model-selected deterministic replay through authenticated chat, real table execution and Soul',
  { timeout: 240000 },
  async t => {
    const browserOrigin = process.env.TABLE_EXECUTION_BROWSER === '1' ? 'http://localhost:5399' : null;
    if (browserOrigin) process.env.WEB_ORIGIN = browserOrigin;
    const webOrigin = browserOrigin ?? 'http://localhost:5173';
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const migrations = await workspaceTableMigrations();
    assert.equal(migrations.length, 1);
    const pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
    cleanup.push(() => pool.end());
    let link;
    const auth = createAuth(
      pool,
      async data => {
        link = data.url;
      },
      async () => {},
    );
    await auth.api.signInMagicLink({
      headers: new Headers({ origin: webOrigin }),
      body: { email: `${randomUUID()}@example.com`, name: 'Execution tester' },
    });
    const login = await auth.handler(new Request(link));
    const cookie = login.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    const ws = await db.create(migrations, { userId: session.user.id });
    t.diagnostic(`Workspace common stream: ${migrations.length}`);
    const s = `"${ws.names.schema}"`;
    assert.deepEqual(
      (await db.platform.query(`SELECT name FROM ${s}.tf_common_migrations ORDER BY name`)).rows.map(row => row.name),
      migrations.map(item => item.name),
    );
    await db.registerPlatform();
    await db.platform.query(
      "UPDATE app.workspace_storage SET stage='ready', runtime_credential='{}', migration_credential='{}', confirmation_credential='{}' WHERE workspace_id=$1",
      [ws.id],
    );
    const runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    cleanup.push(() => runtime.close());
    const objects = new Map();
    const server = createServer(async (request, response) => {
      const key = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'PUT') {
        if (objects.has(key)) {
          response
            .writeHead(412, { 'content-type': 'application/xml' })
            .end('<Error><Code>PreconditionFailed</Code></Error>');
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        objects.set(key, {
          body: Buffer.concat(chunks),
          sha256: request.headers['x-amz-meta-sha256'],
          command: request.headers['x-amz-meta-command-sha256'],
        });
        response.writeHead(200).end();
        return;
      }
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response
        .writeHead(200, {
          'content-length': object.body.length,
          'x-amz-meta-sha256': object.sha256,
          ...(object.command ? { 'x-amz-meta-command-sha256': object.command } : {}),
        })
        .end(object.body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise(resolve => server.close(resolve)));
    const soul = {
      bucket: 'execution-test',
      client: new S3Client({
        region: 'auto',
        endpoint: `http://127.0.0.1:${server.address().port}`,
        forcePathStyle: true,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }),
    };
    cleanup.push(async () => soul.client.destroy());
    const seed = { workspaceId: ws.id, createdBy: ws.userId, createdAt: new Date().toISOString() };
    const initial = await initializeSoul(soul, seed);
    await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, [initial.commit]);
    const team = randomUUID(),
      chat = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
    const requireSources = requireTableSources;
    const publishTableProposal = createTablePublication({
      runtime,
      requireSources,
      requireFiles: requireTableFiles,
      requireImportReference: requireTableImportReference,
      prepareRevision: input =>
        prepareSoulRevision(
          soul,
          seed,
          input.parent ? { ...input.parent, commit: input.expectedParentCommit, bucket: soul.bucket } : initial,
          {
            kind: 'table',
            commandId: input.commandId,
            expectedParentCommit: input.expectedParentCommit,
            createdAt: input.createdAt,
            definition: input.definition,
          },
        ),
    });
    const advanceTableProposal = createTableExecution({
      requireSources,
      requireFiles: requireTableFiles,
      requireImportReference: requireTableImportReference,
      resolveMigrationCredential: async () => db.login(ws, 'migration'),
      batchRows: 2,
    });
    const temporalServer = spawn(
      'temporal',
      ['server', 'start-dev', '--headless', '--ip', '127.0.0.1', '--port', '17283'],
      { stdio: 'ignore' },
    );
    cleanup.push(async () => {
      temporalServer.kill('SIGTERM');
      await new Promise(resolve => temporalServer.once('exit', resolve));
    });
    process.env.TEMPORAL_ADDRESS = '127.0.0.1:17283';
    const temporal = createTemporalClient();
    cleanup.push(() => temporal.connection.close());
    await new Promise(resolve => setTimeout(resolve, 3000));
    const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS });
    cleanup.push(() => connection.close());
    const queue = `execution-${randomUUID()}`,
      storageQueue = `${queue}-storage`;
    process.env.TEMPORAL_TASK_QUEUE = queue;
    process.env.TEMPORAL_STORAGE_TASK_QUEUE = storageQueue;
    const ordinary = await Worker.create({
      connection,
      taskQueue: queue,
      workflowsPath: fileURLToPath(new URL('../dist/table-execution-workflows.js', import.meta.url)),
      activities: { publishTableProposal },
    });
    const activityGates = new Map();
    const storageOptions = {
      connection,
      taskQueue: storageQueue,
      activities: {
        advanceTableProposal: async (...args) => {
          const gate = activityGates.get(args[1]);
          if (gate?.skip) gate.skip--;
          else if (gate) {
            activityGates.delete(args[1]);
            gate.entered.resolve();
            await gate.release.promise;
          }
          return advanceTableProposal(...args);
        },
      },
    };
    let storage = await Worker.create(storageOptions);
    const ordinaryRunning = ordinary.run();
    let storageRunning = storage.run();
    cleanup.push(async () => {
      ordinary.shutdown();
      storage.shutdown();
      await Promise.all([ordinaryRunning, storageRunning]);
    });
    const app = Fastify();
    let dropRequest;
    app.addHook('onSend', async (request, reply, payload) => {
      if (request.body?.requestId === dropRequest && dropRequest) {
        dropRequest = undefined;
        reply.raw.destroy();
      }
      return payload;
    });
    cleanup.push(() => app.close());
    const fileObjects = await filesObjectFixture();
    cleanup.push(() => fileObjects.close());
    registerFilesComposition(app, { runtime, auth, objects: fileObjects.adapter, identity: pool });
    const importObjects = importObjectFixture();
    registerConversations(app, {
      auth,
      service: createConversations(runtime),
      attachments: createAttachments(runtime, importObjects.attachments),
    });
    registerTableChanges(app, {
      ...tableProposalOptions(runtime, importObjects),
      auth,
      resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
    });
    registerTableDispatch(app, { pool, runtime, temporal });
    const { registerTableShellApi } = await import('./table-shell-api.mjs');
    await registerTableShellApi({
      app,
      auth,
      pool,
      runtime,
      db,
      ws,
      workspaceId: ws.id,
      userId: session.user.id,
      soulCommit: initial.commit,
    });
    await app.ready();
    const headers = { cookie, origin: webOrigin },
      base = `/workspaces/${ws.id}/conversations/${chat}/table-changes`;
    const chatBase = `/workspaces/${ws.id}/conversations/${chat}`;
    assert.equal(
      (await app.inject({ method: 'PUT', url: chatBase, headers, payload: { commandId: randomUUID() } })).statusCode,
      200,
    );
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'deterministic-replay-not-a-provider-credential';
    cleanup.push(useModelCatalog());
    cleanup.push(async () => {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    });
    const realFetch = globalThis.fetch;
    let script = [],
      selected = 0,
      outputs = [],
      modelRequests = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (new URL(url).hostname !== 'api.anthropic.com') return realFetch(url, init);
      const request = JSON.parse(init.body);
      if (isTitleRequest(request)) return Response.json(anthropicText('Support tickets'));
      if (isCompletionRequest(request)) return Response.json(completionReply('anthropic'));
      assert.ok(request.tools.some(tool => tool.name === 'tables_propose'));
      modelRequests++;
      if (selected > 0) {
        const content = toolResults(request).at(-1);
        outputs.push(JSON.parse(content.slice(content.indexOf(': ') + 2)));
      }
      const call = script[selected++];
      const decision = call
        ? { kind: 'tool', call: typeof call === 'function' ? call(outputs) : call }
        : { kind: 'answer', text: 'Review the exact table proposal before approving it.' };
      return Response.json(anthropicChat(decision));
    });
    const chatTools = async (calls, text, attachments = []) => {
      script = calls;
      selected = 0;
      outputs = [];
      const sent = await app.inject({
        method: 'PUT',
        url: `${chatBase}/messages/${randomUUID()}`,
        headers,
        payload: {
          commandId: randomUUID(),
          model: 'claude-sonnet',
          parts: [{ kind: 'text', text }, ...attachments.map(attachmentId => ({ kind: 'attachment', attachmentId }))],
        },
      });
      assert.equal(sent.statusCode, 200, sent.body);
      const work = { workspaceId: ws.id, conversationId: chat, turnId: sent.json().turnId, generation: 0 };
      const activity = createConversationActivities(runtime, undefined, importObjects).processConversationReply;
      assert.equal(
        await activity(work),
        'completed',
        'Ordinary metered inference completes the scripted tool selection',
      );
      const receipts = (
        await db.platform.query(
          `SELECT tool,status FROM ${s}.tf_conversation_tool_calls WHERE turn_id=$1 ORDER BY sequence`,
          [work.turnId],
        )
      ).rows;
      assert.deepEqual(
        receipts.map(row => row.status),
        calls.map(() => 'completed'),
        JSON.stringify(outputs),
      );
      assert.equal(await activity(work), 'idle', 'Completed chat replay does not run tools again');
      return outputs;
    };
    const propose = async (plans, text = 'Prepare the reviewed support-ticket changes.') => {
      const result = await chatTools(
        [{ tool: 'schema.context' }, { tool: 'tables.propose', input: JSON.stringify({ plans }) }],
        text,
      );
      const proposal = result.at(-1);
      assert.ok(proposal.id, JSON.stringify(proposal));
      return proposal;
    };
    assert.equal((await app.inject({ url: base })).statusCode, 401);
    const table = randomUUID(),
      field = randomUUID(),
      fileField = randomUUID(),
      secondFileField = randomUUID();
    const definition = {
      formatVersion: 2,
      id: table,
      owningTeamId: team,
      label: 'Private execution tickets',
      fields: [
        { id: field, label: 'Title', kind: 'text', required: false, maxLength: 1000 },
        ...[fileField, secondFileField].map(id => ({
          id,
          label: 'Files',
          kind: 'file',
          required: false,
          cardinality: 'many',
          access: 'independent',
        })),
      ],
      uniqueKeys: [],
    };
    const complete = async proposed => {
      const { id } = proposed;
      const manifest = (await db.platform.query(`SELECT manifest FROM ${s}.tf_table_proposals WHERE id=$1`, [id]))
        .rows[0].manifest;
      assert.ok(
        manifest.sources.some(source => source.kind === 'private-conversation' && source.conversationId === chat),
      );
      const approved = await app.inject({
        method: 'PUT',
        url: `${base}/${id}/decision`,
        headers,
        payload: { commandId: randomUUID(), digest: proposed.digest, decision: 'approve' },
      });
      assert.equal(approved.statusCode, 200, approved.body);
      for (let i = 0; i < 300; i++) {
        const result = await app.inject({ url: `${base}/${id}`, headers });
        assert.equal(result.statusCode, 200, result.body);
        if (result.json().status === 'completed') {
          const history = await temporal.client.workflow.getHandle(`table-proposal-v2-${ws.id}-${id}`).fetchHistory();
          assert.equal(JSON.stringify(history).includes('Private execution tickets'), false);
          return result.json().plans[0].receipt.revision;
        }
        if (result.json().status === 'failed') assert.fail(result.body);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail('API dispatch did not complete');
    };
    const run = async plan => complete(await propose([plan]));
    await auth.api.signInMagicLink({
      headers: new Headers({ origin: webOrigin }),
      body: { email: `${randomUUID()}@example.com`, name: 'Support member' },
    });
    const memberLogin = await auth.handler(new Request(link));
    const memberCookie = memberLogin.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    const memberSession = await auth.api.getSession({ headers: new Headers({ cookie: memberCookie }) });
    const member = { membershipId: randomUUID(), cookie: memberCookie };
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      member.membershipId,
      memberSession.user.id,
    ]);
    await db.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [
      member.membershipId,
      team,
    ]);
    const { proveSupportJourney } = await import('./table-support-journey.mjs');
    const pauseExecution = proposalId => {
      const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers(), skip: 2 };
      activityGates.set(proposalId, gate);
      cleanup.push(async () => gate.release.resolve());
      return gate;
    };
    await proveSupportJourney({
      app,
      headers,
      workspaceId: ws.id,
      chatBase,
      team,
      propose,
      complete,
      chatTools,
      member,
      pauseExecution,
    });
    const revision = await run({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision: null,
      target: definition,
      transforms: { outputs: [] },
    });
    const projection = (
      await db.platform.query(`SELECT projection FROM ${s}.tf_table_executions WHERE table_id=$1`, [table])
    ).rows[0].projection;
    assert.deepEqual(await readVerifiedProjection(soul, ws.id, projection), definition);
    const recordId = randomUUID();
    await run({
      kind: 'records',
      tableId: table,
      dependsOn: [],
      expectedRevision: revision,
      changes: [{ kind: 'create', recordId, values: { [field]: { kind: 'text', value: '  printer  ' } } }],
    });
    const next = await run({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision: revision,
      target: definition,
      transforms: { outputs: [{ fieldId: field, expression: { op: 'trim', input: { op: 'field', fieldId: field } } }] },
    });
    const response = await app.inject({ url: `/workspaces/${ws.id}/tables/${table}/rows?revision=${next}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json()[0].values[field].value, 'printer');
    const requestId = randomUUID(),
      directId = randomUUID(),
      recordBase = `/workspaces/${ws.id}/tables/${table}`;
    const state = await app.inject({ url: recordBase, headers });
    assert.equal(state.statusCode, 200, state.body);
    assert.equal(state.json().saved.revision, next);
    assert.equal(state.json().applied.revision, next);
    assert.deepEqual(state.json().applied.definition, definition);
    const schemaHistory = await app.inject({ url: `${recordBase}/schema-history?limit=1`, headers });
    assert.equal(schemaHistory.statusCode, 200, schemaHistory.body);
    assert.equal(schemaHistory.json().entries.length, 1);
    assert.ok(schemaHistory.json().nextCursor);
    const nextHistory = await app.inject({
      url: `${recordBase}/schema-history?limit=1&after=${schemaHistory.json().nextCursor}`,
      headers,
    });
    assert.equal(nextHistory.json().entries.length, 1);
    assert.equal(nextHistory.json().nextCursor, null);
    assert.notEqual(nextHistory.json().entries[0].id, schemaHistory.json().entries[0].id);
    assert.equal(schemaHistory.json().entries[0].receipt.status, 'completed');
    const transformed = await app.inject({ url: `${recordBase}/rows/${recordId}/history`, headers });
    assert.equal(transformed.statusCode, 200, transformed.body);
    assert.ok(transformed.json().some(entry => entry.operation === 'transform'));
    assert.deepEqual((await app.inject({ url: `${recordBase}/requests/${requestId}`, headers })).json(), {
      status: 'unknown',
    });
    const payload = {
      requestId,
      kind: 'create',
      tableId: table,
      revision: next,
      recordId: directId,
      values: { [field]: { kind: 'text', value: 'Direct write' } },
    };
    const direct = await app.inject({ method: 'POST', url: `${recordBase}/rows`, headers, payload });
    assert.equal(direct.statusCode, 200, direct.body);
    assert.deepEqual(direct.json().values, {
      [field]: { kind: 'text', value: 'Direct write' },
      [fileField]: null,
      [secondFileField]: null,
    });
    assert.deepEqual(
      (await app.inject({ method: 'POST', url: `${recordBase}/rows`, headers, payload })).json(),
      direct.json(),
    );
    assert.deepEqual((await app.inject({ url: `${recordBase}/requests/${requestId}`, headers })).json(), {
      status: 'applied',
      result: direct.json(),
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `${recordBase}/rows`,
      headers,
      payload: { ...payload, values: {} },
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    const history = await app.inject({ url: `${recordBase}/rows/${directId}/history`, headers });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json().length, 1);
    const deleted = await app.inject({
      method: 'POST',
      url: `${recordBase}/rows`,
      headers,
      payload: {
        requestId: randomUUID(),
        kind: 'delete',
        tableId: table,
        recordId: directId,
        revision: next,
        expectedToken: direct.json().token,
      },
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const trash = await app.inject({ url: `${recordBase}/deleted-rows?limit=1`, headers });
    assert.equal(trash.statusCode, 200, trash.body);
    assert.equal(trash.json().nextCursor, null);
    assert.equal(trash.json().records[0].id, directId);
    assert.equal(trash.json().records[0].token, deleted.json().token);
    assert.ok(Date.parse(trash.json().records[0].recoverableUntil) > Date.now());
    assert.deepEqual(Object.keys(trash.json().records[0]).sort(), ['deletedAt', 'id', 'recoverableUntil', 'token']);
    const restored = await app.inject({
      method: 'POST',
      url: `${recordBase}/rows`,
      headers,
      payload: {
        requestId: randomUUID(),
        kind: 'restore',
        tableId: table,
        recordId: directId,
        revision: next,
        expectedToken: trash.json().records[0].token,
        historyId: history.json()[0].id,
        version: 'after',
      },
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().values, direct.json().values);
    assert.deepEqual((await app.inject({ url: `${recordBase}/deleted-rows`, headers })).json(), {
      records: [],
      nextCursor: null,
    });
    const fileId = randomUUID();
    const uploaded = await app.inject({
      method: 'PUT',
      url: `/workspaces/${ws.id}/files/${fileId}/content?name=proof.txt&parentId=null&mediaType=text%2Fplain`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('private table file'),
    });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const fileRequest = randomUUID(),
      fileRecord = randomUUID();
    const withFile = await app.inject({
      method: 'POST',
      url: `${recordBase}/rows`,
      headers,
      payload: {
        requestId: fileRequest,
        kind: 'create',
        tableId: table,
        revision: next,
        recordId: fileRecord,
        values: { [fileField]: { kind: 'file', fileIds: [fileId] } },
      },
    });
    assert.equal(withFile.statusCode, 200, withFile.body);
    const fileHistoryUrl = `${recordBase}/rows/${fileRecord}/history`;
    assert.equal((await app.inject({ url: fileHistoryUrl, headers })).statusCode, 200);
    await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=clock_timestamp() WHERE id=$1`, [fileId]);
    const unavailableHistory = await app.inject({ url: fileHistoryUrl, headers });
    assert.equal(unavailableHistory.statusCode, 200, unavailableHistory.body);
    assert.deepEqual(
      unavailableHistory.json().map(entry => entry.unavailable_file_ids),
      [[fileId]],
    );
    const unavailableReceipt = await app.inject({ url: `${recordBase}/requests/${fileRequest}`, headers });
    assert.equal(unavailableReceipt.statusCode, 200, unavailableReceipt.body);
    assert.deepEqual(unavailableReceipt.json(), { status: 'applied', result: withFile.json() });
    await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=NULL WHERE id=$1`, [fileId]);
    await t.test(
      'lost HTTP acknowledgement reconciles 300 unique file references across two fields and keeps the receipt when the last file becomes unavailable',
      async () => {
        const fileIds = [fileId];
        for (let i = 1; i < 300; i++) {
          const id = randomUUID();
          const upload = await app.inject({
            method: 'PUT',
            url: `/workspaces/${ws.id}/files/${id}/content?name=proof-${i}.txt&parentId=null&mediaType=text%2Fplain`,
            headers: { ...headers, 'content-type': 'application/octet-stream' },
            payload: Buffer.from('receipt proof'),
          });
          assert.equal(upload.statusCode, 200, upload.body);
          fileIds.push(id);
        }
        const requestId = randomUUID(),
          recordId = randomUUID();
        const payload = {
          requestId,
          kind: 'create',
          tableId: table,
          revision: next,
          recordId,
          values: {
            [fileField]: { kind: 'file', fileIds: fileIds.slice(0, 200) },
            [secondFileField]: { kind: 'file', fileIds: fileIds.slice(100) },
          },
        };
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        dropRequest = requestId;
        await assert.rejects(
          fetch(`${address}${recordBase}/rows`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
          /fetch failed/,
        );
        assert.equal(dropRequest, undefined);
        const receipt = await app.inject({ url: `${recordBase}/requests/${requestId}`, headers });
        assert.equal(receipt.statusCode, 200, receipt.body);
        assert.equal(receipt.json().status, 'applied');
        assert.deepEqual(receipt.json().result.values, { ...payload.values, [field]: null });
        const replay = await app.inject({ method: 'POST', url: `${recordBase}/rows`, headers, payload });
        assert.equal(replay.statusCode, 200, replay.body);
        assert.deepEqual(replay.json(), receipt.json().result);
        assert.equal((await app.inject({ url: `${recordBase}/rows/${recordId}/history`, headers })).json().length, 1);
        await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=clock_timestamp() WHERE id=$1`, [fileIds.at(-1)]);
        const kept = await app.inject({ url: `${recordBase}/requests/${requestId}`, headers });
        assert.equal(kept.statusCode, 200, kept.body);
        assert.deepEqual(kept.json(), receipt.json());
        const keptReplay = await app.inject({ method: 'POST', url: `${recordBase}/rows`, headers, payload });
        assert.equal(keptReplay.statusCode, 200, keptReplay.body);
        assert.deepEqual(keptReplay.json(), receipt.json().result);
        await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=NULL WHERE id=$1`, [fileIds.at(-1)]);
      },
    );
    await t.test(
      'API resume restarts a completed stable workflow after revocation and cancellation but not control replay',
      async () => {
        const recordId = randomUUID();
        const proposed = await propose([
          {
            kind: 'records',
            tableId: table,
            dependsOn: [],
            expectedRevision: next,
            changes: [
              { kind: 'create', recordId, values: { [field]: { kind: 'text', value: 'Resumed through queue' } } },
            ],
          },
        ]);
        const { id, digest } = proposed;
        const gate = (skip = 0) => {
          const value = { entered: Promise.withResolvers(), release: Promise.withResolvers(), skip };
          activityGates.set(id, value);
          cleanup.push(async () => value.release.resolve());
          return value;
        };
        const wait = async predicate => {
          for (let i = 0; i < 200; i++) {
            const value = await predicate();
            if (value) return value;
            await delay(100);
          }
          assert.fail('Queue state did not converge');
        };
        const workflowId = `table-proposal-v2-${ws.id}-${id}`;
        const completedRun = async previous =>
          wait(async () => {
            const description = await temporal.client.workflow.getHandle(workflowId).describe();
            return description.status.name === 'COMPLETED' && description.runId !== previous ? description.runId : null;
          });
        const control = payload => app.inject({ method: 'PUT', url: `${base}/${id}/control`, headers, payload });
        const first = gate();
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: `${base}/${id}/decision`,
              headers,
              payload: { commandId: randomUUID(), digest, decision: 'approve' },
            })
          ).statusCode,
          200,
        );
        await Promise.race([
          first.entered.promise,
          delay(20000).then(() => assert.fail('Approved proposal never reached the storage queue')),
        ]);
        await db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id='revoked-owner' WHERE id=$1`, [chat]);
        first.release.resolve();
        const revokedRun = await completedRun();
        assert.deepEqual(
          (await db.platform.query(`SELECT phase,error_code FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [id]))
            .rows[0],
          { phase: 'blocked', error_code: 'access-denied' },
        );
        assert.equal((await control({ commandId: randomUUID(), digest, operation: 'resume' })).statusCode, 404);
        await db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id=$2 WHERE id=$1`, [
          chat,
          session.user.id,
        ]);
        await delay(4500);
        assert.equal((await temporal.client.workflow.getHandle(workflowId).describe()).runId, revokedRun);
        const second = gate();
        const resume = { commandId: randomUUID(), digest, operation: 'resume' };
        assert.equal((await control(resume)).statusCode, 200);
        await Promise.race([
          second.entered.promise,
          delay(20000).then(() => assert.fail('Resume never restarted the completed workflow')),
        ]);
        assert.equal((await control({ commandId: randomUUID(), digest, operation: 'cancel' })).statusCode, 200);
        second.release.resolve();
        const cancelledRun = await completedRun(revokedRun);
        const replay = await control(resume);
        assert.equal(replay.statusCode, 200, replay.body);
        assert.equal(replay.json().cancelled, true);
        await delay(4500);
        assert.equal((await temporal.client.workflow.getHandle(workflowId).describe()).runId, cancelledRun);
        const third = gate(1);
        const consumedResume = { commandId: randomUUID(), digest, operation: 'resume' };
        assert.equal((await control(consumedResume)).statusCode, 200);
        await Promise.race([
          third.entered.promise,
          delay(20000).then(() => assert.fail('Fresh resume never reached its next activity')),
        ]);
        await db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id='revoked-owner' WHERE id=$1`, [chat]);
        third.release.resolve();
        const reblockedRun = await completedRun(cancelledRun);
        const blocked = (
          await db.platform.query(
            `SELECT e.phase,e.resumed_sequence,(SELECT max(sequence) FROM ${s}.tf_table_proposal_controls WHERE proposal_id=e.proposal_id) latest_sequence FROM ${s}.tf_table_executions e WHERE proposal_id=$1`,
            [id],
          )
        ).rows[0];
        assert.equal(blocked.phase, 'blocked');
        assert.equal(blocked.resumed_sequence, blocked.latest_sequence);
        await db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id=$2 WHERE id=$1`, [
          chat,
          session.user.id,
        ]);
        assert.equal((await control(consumedResume)).statusCode, 200);
        await delay(4500);
        assert.equal((await temporal.client.workflow.getHandle(workflowId).describe()).runId, reblockedRun);
        storage.shutdown();
        await storageRunning;
        const resumed = await control({ commandId: randomUUID(), digest, operation: 'resume' });
        assert.equal(resumed.statusCode, 200, resumed.body);
        storage = await Worker.create(storageOptions);
        storageRunning = storage.run();
        const finalRun = await completedRun(reblockedRun);
        assert.notEqual(finalRun, revokedRun);
        const status = await app.inject({ url: `${base}/${id}/status`, headers });
        assert.equal(status.json().status, 'completed', status.body);
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::int n FROM ${s}.tf_table_proposal_receipts WHERE proposal_id=$1 AND receipt->>'status'='completed'`,
              [id],
            )
          ).rows[0].n,
          1,
        );
        const records = await app.inject({ url: `${recordBase}/rows?revision=${next}`, headers });
        assert.equal(records.json().find(row => row.id === recordId).values[field].value, 'Resumed through queue');
      },
    );
    await db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id='revoked-owner' WHERE id=$1`, [chat]);
    const revokedHistory = await app.inject({ url: `${recordBase}/schema-history`, headers });
    assert.equal(revokedHistory.statusCode, 200, revokedHistory.body);
    assert.ok(revokedHistory.json().entries.every(entry => entry.definition === null));
    assert.equal(revokedHistory.body.includes('Private execution tickets'), false);
    assert.equal((await app.inject({ url: recordBase, headers })).json().saved.definition, null);
    await db.platform.query(`UPDATE ${s}.tf_conversations SET owner_user_id=$2 WHERE id=$1`, [chat, session.user.id]);
    await db.platform.query(`UPDATE ${s}.tf_memberships SET removed_at=clock_timestamp() WHERE id=$1`, [
      ws.membershipId,
    ]);
    for (const url of [
      recordBase,
      `${recordBase}/schema-history`,
      `${recordBase}/deleted-rows`,
      `${recordBase}/rows/${directId}/history`,
    ]) {
      const denied = await app.inject({ url, headers });
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(denied.body.includes('Private execution tickets'), false);
    }
    await db.platform.query(`UPDATE ${s}.tf_memberships SET removed_at=NULL WHERE id=$1`, [ws.membershipId]);
    if (browserOrigin) {
      const proposed = await propose([
        {
          kind: 'schema',
          tableId: table,
          dependsOn: [],
          expectedRevision: next,
          target: { ...definition, label: 'Browser execution tickets' },
          transforms: { outputs: [] },
        },
      ]);
      const proposalId = proposed.id;
      const { proveTableBrowser } = await import('../../web/test/tables-e2e.browser.mjs');
      await proveTableBrowser({
        app,
        cookie,
        origin: browserOrigin,
        workspaceId: ws.id,
        chatId: chat,
        proposalId,
        userId: session.user.id,
        membershipId: ws.membershipId,
        tableId: table,
        recordId: directId,
      });
      const receipt = (await app.inject({ url: `${base}/${proposalId}/status`, headers })).json();
      assert.equal(receipt.status, 'completed');
      const browserRecords = (
        await app.inject({ url: `${recordBase}/rows?revision=${receipt.plans[0].receipt.revision}`, headers })
      ).json();
      assert.equal(browserRecords.find(row => row.id === directId).values[field].value, 'Browser saved value');
    }
    process.stdout.write(
      `${JSON.stringify({ event: 'tables-chat-proof', provider: 'model-selected deterministic replay', externalProvider: false, modelRequests })}\n`,
    );
  },
);
