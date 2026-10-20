import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { registerAgentTasks } from '../src/agent-tasks.ts';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { encryptCredential } from '../../../packages/workspaces/src/credentials.ts';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import { createConversations } from '@tulipfarm/conversations';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { createTaskApprovalDecision } from '@tulipfarm/agents/task-approvals';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../../packages/tables/test/fixture.mjs';
import { createAgentRecordTools } from '../../../packages/agents/src/record-tools.ts';
import { createAgentExecutor } from '@tulipfarm/agents';
import { createTaskRuntime } from '@tulipfarm/agents/task-runtime';

test(
  'default app authenticates private tasks through real HTTP and retains explicitly attached bytes across continuation',
  { timeout: 120000 },
  async t => {
    const previous = process.env;
    process.env = {
      PATH: previous.PATH,
      NODE_ENV: 'test',
      TEST_ADMIN_DATABASE_URL: previous.TEST_ADMIN_DATABASE_URL,
      BETTER_AUTH_SECRET: 'synthetic-task-foundation-secret-at-least-32-characters',
      BETTER_AUTH_URL: 'http://127.0.0.1:3001',
      WEB_ORIGIN: 'http://localhost:5173',
      TEMPORAL_ADDRESS: '127.0.0.1:1',
      WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
      WORKSPACE_RUNTIME_REPLICAS: '1',
      WORKSPACE_DATABASE_CONNECTION_BUDGET: '120',
      WORKSPACE_RUNTIME_KEY_ID: 'test',
      WORKSPACE_RUNTIME_KEY: '11'.repeat(32),
      WORKSPACE_CONFIRMATION_KEY_ID: 'test',
      WORKSPACE_CONFIRMATION_KEY: '22'.repeat(32),
      INTEGRATION_CREDENTIAL_KEY_ID: 'test',
      INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
      EMAIL_DELIVERY_KEY_ID: 'test',
      EMAIL_DELIVERY_KEY: '44'.repeat(32),
    };
    let db, identity, runtime, app, attachmentApp, directory;
    t.after(async () => {
      await attachmentApp?.close();
      await app?.close();
      await runtime?.close();
      await identity?.end();
      await db?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
      process.env = previous;
    });
    db = await fixture();
    await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
    for (const name of ['0001_baseline.sql'])
      await db.platform.query(await readFile(new URL(`../../database/migrations/${name}`, import.meta.url), 'utf8'));
    identity = new Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
    const links = [],
      auth = createAuth(
        identity,
        async ({ url }) => links.push(url),
        async () => {},
      );
    async function signIn(name) {
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: process.env.WEB_ORIGIN }),
        body: { email: `${randomUUID()}@example.com`, name },
      });
      const response = await auth.handler(new Request(links.pop()));
      const cookie = response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
      return { id: (await auth.api.getSession({ headers: new Headers({ cookie }) })).user.id, cookie };
    }
    const admin = await signIn('Admin'),
      owner = await signIn('Owner'),
      stranger = await signIn('Stranger');
    const migrations = await workspaceTableMigrations();
    const w = await db.create(migrations, { userId: admin.id }),
      other = await db.create(migrations);
    const table = name => `"${w.names.schema}".${name}`;
    const membershipId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
      [membershipId, owner.id, randomUUID(), stranger.id],
    );
    process.env.DATABASE_URL = db.connectionString;
    process.env.WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL = db.login(w, 'confirmation');
    for (const [workspace, slug] of [
      [w, 'tasks-proof'],
      [other, 'other-task-proof'],
    ]) {
      await identity.query(
        `INSERT INTO app.workspaces (id,request_id,created_by,name,slug,soul_commit,soul_bucket,soul_key,ready_at) VALUES ($1,$2,$3,'Tasks proof',$4,$5,'fixture','fixture',now()) ON CONFLICT (id) DO UPDATE SET soul_commit=excluded.soul_commit, soul_bucket='fixture', soul_key='fixture', ready_at=now()`,
        [workspace.id, randomUUID(), admin.id, slug, 'a'.repeat(40)],
      );
      const credential = encryptCredential(
        db.login(workspace),
        { workspaceId: workspace.id, generation: 1, capability: 'runtime' },
        { keyId: 'test', key: Buffer.from('11'.repeat(32), 'hex') },
      );
      const confirmation = encryptCredential(
        db.login(workspace, 'confirmation'),
        { workspaceId: workspace.id, generation: 1, capability: 'confirmation' },
        { keyId: 'test', key: Buffer.from('22'.repeat(32), 'hex') },
      );
      await identity.query(
        `INSERT INTO app.workspace_storage (workspace_id,stage,runtime_credential,migration_credential,confirmation_credential) VALUES ($1,'ready',$2,'{}',$3) ON CONFLICT (workspace_id) DO UPDATE SET stage='ready', runtime_credential=excluded.runtime_credential, migration_credential=excluded.migration_credential, confirmation_credential=excluded.confirmation_credential`,
        [workspace.id, credential, confirmation],
      );
    }
    await db.platform.query(
      `GRANT USAGE ON SCHEMA app TO "${w.names.confirmation}"; GRANT SELECT(workspace_id,generation,stage,confirmation_credential) ON app.workspace_storage TO "${w.names.confirmation}"`,
    );
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({
        workspaceId: id,
        generation: 1,
        connectionString: db.login(id === w.id ? w : other),
      }),
    });
    const agent = await savedTaskAgent(db, w, runtime, owner.id, membershipId);
    app = buildApp({ agentModel: null });
    const address = await app.listen({ host: '127.0.0.1', port: 0 }),
      base = `/v1/workspaces/${w.id}/agent-tasks`;
    async function http(who, method, path, body, status = 200, host = address, origin = process.env.WEB_ORIGIN) {
      const response = await fetch(`${host}${path}`, {
        method,
        headers: { cookie: who?.cookie ?? '', origin, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return result;
    }
    await http(null, 'GET', base, undefined, 401);
    const input = { requestId: randomUUID(), agentId: agent.agentId, text: 'Private cleanup request' };
    await http(owner, 'POST', base, input, 403, address, 'https://foreign.example');
    await http(owner, 'POST', base, { ...input, approved: true }, 400);
    const first = await http(owner, 'POST', base, input);
    assert.deepEqual(await http(owner, 'POST', base, input), first);
    await http(owner, 'POST', base, { ...input, text: 'Changed' }, 409);
    assert.deepEqual(
      (await http(owner, 'GET', base)).tasks.map(task => task.id),
      [first.id],
    );
    const detail = await http(owner, 'GET', `${base}/${first.id}`);
    assert.equal(detail.definitionRevision, agent.revision);
    assert.equal(detail.flowId, first.id);
    assert.deepEqual(detail.cost, { chargedCreditUnits: '0', heldCreditUnits: '0' });
    assert.equal((await http(owner, 'GET', `${base}/${first.id}/history`)).messages[0].text, input.text);
    for (const who of [admin, stranger]) {
      await http(who, 'GET', `${base}/${first.id}`, undefined, 404);
      await http(who, 'GET', `${base}/${first.id}/history`, undefined, 404);
      await http(
        who,
        'POST',
        `${base}/${first.id}/reopen`,
        { requestId: randomUUID(), expectedGeneration: 0, text: 'Steal' },
        404,
      );
      assert.deepEqual((await http(who, 'GET', base)).tasks, []);
    }
    await http(owner, 'GET', `/v1/workspaces/${other.id}/agent-tasks/${first.id}`, undefined, 404);
    await http(
      owner,
      'POST',
      `${base}/${first.id}/reopen`,
      { requestId: randomUUID(), expectedGeneration: 0, text: 'Too soon' },
      409,
    );
    for (const name of ['tf_agent_runs', 'tf_agent_tool_calls'])
      assert.equal((await db.platform.query(`SELECT count(*)::integer AS count FROM ${table(name)}`)).rows[0].count, 0);
    await createAgentExecutor({ runtime }).configure(
      w.id,
      { kind: 'human', userId: admin.id, membershipId: w.membershipId },
      { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
    );
    await createTaskRuntime(runtime, null).process(w.id, first.id);
    assert.equal((await http(owner, 'GET', `${base}/${first.id}`)).status, 'paused');
    assert.equal((await http(owner, 'GET', `${base}/${first.id}`)).pauseReason, 'model');
    assert.equal((await http(owner, 'GET', base)).tasks.find(task => task.id === first.id).pauseReason, 'model');
    const pausedHistory = await http(owner, 'GET', `${base}/${first.id}/history`);
    const continuation = {
      requestId: randomUUID(),
      expectedGeneration: 0,
      expectedSequence: pausedHistory.messages.at(-1).sequence,
      text: 'Continue when configured.',
    };
    await http(admin, 'POST', `${base}/${first.id}/continue`, continuation, 404);
    const resumed = await http(owner, 'POST', `${base}/${first.id}/continue`, continuation);
    assert.equal(resumed.status, 'pending');
    assert.equal((await http(owner, 'GET', `${base}/${first.id}`)).pauseReason, null);
    assert.deepEqual(await http(owner, 'POST', `${base}/${first.id}/continue`, continuation), resumed);

    await t.test('real HTTP requires selected invocation teams for admins and members', async () => {
      for (const who of [admin, stranger]) await http(who, 'POST', base, { ...input, requestId: randomUUID() }, 404);
      await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        w.membershipId,
        agent.teamId,
      ]);
      const selected = await http(admin, 'POST', base, { ...input, requestId: randomUUID() });
      assert.equal(selected.status, 'pending');
      assert.equal((await http(admin, 'GET', `${base}/${selected.id}/history`)).messages[0].text, input.text);
      await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
        w.membershipId,
        agent.teamId,
      ]);
      await http(admin, 'POST', base, { ...input, requestId: randomUUID() }, 404);
      await http(admin, 'GET', `${base}/${selected.id}/history`, undefined, 404);
      assert.equal((await http(admin, 'GET', `${base}/${selected.id}`)).status, 'pending');
      await createTaskRuntime(runtime, null).process(w.id, selected.id);
      assert.equal((await http(admin, 'GET', `${base}/${selected.id}`)).status, 'failed');
      await http(
        admin,
        'POST',
        `${base}/${selected.id}/continue`,
        { requestId: randomUUID(), expectedGeneration: 0, expectedSequence: 0, text: 'Cannot resume' },
        404,
      );
    });

    directory = await mkdtemp(join(tmpdir(), 'agent-task-attachments-'));
    const pathFor = key => join(directory, createHash('sha256').update(key).digest('hex'));
    const bytes = {
      putIfAbsent: async (key, content) => {
        try {
          await writeFile(pathFor(key), content, { flag: 'wx' });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      },
      read: key => readFile(pathFor(key)),
      remove: key => rm(pathFor(key), { force: true }),
    };
    const attachments = createAttachments(runtime, bytes),
      conversations = createConversations(runtime);
    const conversationId = randomUUID(),
      attachmentId = randomUUID(),
      content = Buffer.from('Private attached report.');
    await conversations.create(w.id, owner.id, { chatId: conversationId, commandId: randomUUID() });
    await attachments.reserve(w.id, owner.id, conversationId, attachmentId, {
      filename: 'report.txt',
      mediaType: 'text/plain',
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    await attachments.upload(w.id, owner.id, conversationId, attachmentId, content);
    await conversations.send(w.id, owner.id, conversationId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'attachment', attachmentId }],
    });
    const source = { kind: 'attachment', conversationId, attachmentId };
    const attached = await http(owner, 'POST', base, { ...input, requestId: randomUUID(), sources: [source] });
    attachmentApp = Fastify();
    attachmentApp.register(
      async routes =>
        registerAgentTasks(routes, {
          auth,
          runtime,
          attachments,
          decide: createTaskApprovalDecision({
            runtime,
            resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
          }),
        }),
      { prefix: '/v1' },
    );
    const attachmentAddress = await attachmentApp.listen({ host: '127.0.0.1', port: 0 });
    await t.test(
      'real owner HTTP decisions bind exact immutable changes and produce actual record effects',
      async () => {
        const name = textField(),
          recordId = randomUUID(),
          revision = 'b'.repeat(40);
        const { definition } = await createTableWithRows({
          db,
          workspace: w,
          runtime,
          revision,
          definition: tableDefinition({ owningTeamId: agent.teamId, label: 'Names', fields: [name] }),
          records: [{ id: recordId, values: textValues(name, ' eve ') }],
        });
        const tableId = definition.id,
          fieldId = name.id;
        const permissions = ['table.row.read', 'table.row.update', 'table.row.create'];
        for (const permission of permissions)
          await db.platform.query(`INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
            agent.teamId,
            tableId,
            permission,
          ]);
        const scope = [{ assetId: tableId, permissions }];
        await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
          agent.activationId,
          JSON.stringify(scope),
        ]);
        await createAgentExecutor({ runtime }).configure(
          w.id,
          { kind: 'human', userId: admin.id, membershipId: w.membershipId },
          { agentId: agent.agentId, version: 1, enabled: true, teamIds: [agent.teamId], limits: scope },
        );
        const records = createAgentRecordTools(runtime);
        const task = await http(owner, 'POST', base, {
          requestId: randomUUID(),
          agentId: agent.agentId,
          text: 'Clean Eve',
          scope,
        });
        const unread = {
          tool: 'rows.update',
          tableId,
          expectedAppliedRevision: revision,
          recordId,
          values: { [fieldId]: { kind: 'text', value: 'Eve' } },
        };
        assert.deepEqual(
          await http(
            owner,
            'POST',
            `${base}/${task.id}/proposals`,
            { requestId: randomUUID(), generation: 0, calls: [unread] },
            409,
          ),
          { error: 'record-conflict' },
        );
        const call = {
          ...unread,
          expectedToken: (await records.getRecord(w.id, owner.id, tableId, revision, recordId)).token,
        };
        const proposal = await http(owner, 'POST', `${base}/${task.id}/proposals`, {
          requestId: randomUUID(),
          generation: 0,
          calls: [call],
        });
        const root = `${base}/${task.id}/proposals/${proposal.id}`;
        assert.equal(proposal.actions[0].before.values[fieldId].value, ' eve ');
        assert.equal(proposal.actions[0].after.values[fieldId].value, 'Eve');
        const execution = { actionId: proposal.actions[0].id };
        assert.equal((await http(owner, 'POST', `${root}/execute`, execution)).actions[0].status, 'unattempted');
        assert.equal(
          (await records.getRecord(w.id, owner.id, tableId, revision, recordId)).values[fieldId].value,
          ' eve ',
        );
        for (const person of [admin, stranger]) {
          await http(person, 'GET', root, undefined, 404);
          await http(person, 'POST', `${root}/decision`, { digest: proposal.digest, decision: 'approve' }, 404);
        }
        await http(
          owner,
          'POST',
          `${root}/decision`,
          { digest: proposal.digest, decision: 'approve', calls: [call] },
          400,
        );
        await http(owner, 'POST', `${root}/decision`, { digest: 'f'.repeat(64), decision: 'approve' }, 409);
        const decision = await http(owner, 'POST', `${root}/decision`, {
          digest: proposal.digest,
          decision: 'approve',
        });
        assert.deepEqual(
          await http(owner, 'POST', `${root}/decision`, { digest: proposal.digest, decision: 'approve' }),
          decision,
        );
        const result = await http(owner, 'POST', `${root}/execute`, execution);
        assert.equal(result.actions[0].status, 'completed');
        assert.deepEqual(await http(owner, 'POST', `${root}/execute`, execution), result);
        assert.equal(
          (await records.getRecord(w.id, owner.id, tableId, revision, recordId)).values[fieldId].value,
          'Eve',
        );
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::integer AS count FROM ${table('tf_agent_task_action_receipts')} WHERE call_id=$1`,
              [proposal.actions[0].id],
            )
          ).rows[0].count,
          1,
        );
        await db.platform.query(`DELETE FROM ${table('tf_agent_grants')} WHERE agent_id=$1 AND permission='invoke'`, [
          agent.agentId,
        ]);
        await http(owner, 'GET', root, undefined, 404);
        assert.equal((await http(owner, 'GET', `${root}/status`)).actions[0].status, 'completed');
        assert.equal((await http(owner, 'GET', `${base}/${task.id}`)).id, task.id);
        await db.platform.query(
          `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke')`,
          [agent.agentId, agent.teamId],
        );
      },
    );
    const filePath = `${base}/${attached.id}/attachments/${attachmentId}/content`;
    async function download() {
      const response = await fetch(`${attachmentAddress}${filePath}`, { headers: { cookie: owner.cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), 'Private attached report.');
    }
    await download();
    await http(admin, 'GET', filePath, undefined, 404, attachmentAddress);
    await http(
      owner,
      'GET',
      `${base}/${first.id}/attachments/${attachmentId}/content`,
      undefined,
      404,
      attachmentAddress,
    );
    await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [attached.id]);
    const reopen = { requestId: randomUUID(), expectedGeneration: 0, text: 'Use the same attachment next time.' };
    assert.deepEqual(await http(owner, 'POST', `${base}/${attached.id}/reopen`, reopen), {
      id: attached.id,
      generation: 1,
      status: 'pending',
    });
    assert.deepEqual(await http(owner, 'POST', `${base}/${attached.id}/reopen`, reopen), {
      id: attached.id,
      generation: 1,
      status: 'pending',
    });
    await download();
    const page = await http(owner, 'GET', `${base}/${attached.id}/history?limit=1`);
    assert.deepEqual(page.messages[0].sources, [source]);
    assert.equal(page.nextCursor, 0);
    assert.equal(
      (await http(owner, 'GET', `${base}/${attached.id}/history?after=0&limit=1`)).messages[0].text,
      reopen.text,
    );
    await db.platform.query(`DELETE FROM ${table('tf_agent_grants')} WHERE agent_id=$1 AND permission='invoke'`, [
      agent.agentId,
    ]);
    await http(owner, 'GET', filePath, undefined, 404, attachmentAddress);
    await http(owner, 'GET', `${base}/${attached.id}/history`, undefined, 404);
    assert.equal((await http(owner, 'GET', `${base}/${attached.id}`)).generation, 1);
    assert.deepEqual(await http(owner, 'POST', `${base}/${attached.id}/reopen`, reopen), {
      id: attached.id,
      generation: 1,
      status: 'pending',
    });
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke')`,
      [agent.agentId, agent.teamId],
    );
    await download();
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [membershipId]);
    await http(owner, 'GET', filePath, undefined, 404, attachmentAddress);
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      randomUUID(),
      owner.id,
    ]);
    await http(owner, 'GET', `${base}/${attached.id}`, undefined, 404);
    await http(owner, 'GET', filePath, undefined, 404, attachmentAddress);
  },
);
