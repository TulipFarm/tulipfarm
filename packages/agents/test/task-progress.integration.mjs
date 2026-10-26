import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { Pool } from 'pg';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableWithRows, tableDefinition, textField, text, textValues } from '../../tables/test/fixture.mjs';
import { createAgentRecordTools } from '../src/record-tools.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskProgress } from '../src/task-progress.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { createTaskApprovals, createTaskApprovalDecision } from '../src/task-approvals.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { createAuth } from '../../../apps/api/dist/auth.js';
import { encryptCredential } from '../../workspaces/src/credentials.ts';
import { nativeReply, useCall } from './native-fixture.mjs';
import { modelCatalogOf } from '../../../apps/worker/test/model-catalog-fixture.mjs';

const route = {
  id: 'task-progress',
  modelId: 'claude-opus-5-5',
  provider: 'anthropic',
  deployment: 'claude-opus-5-5',
  location: 'test',
  adapterVersion: 1,
  qualification: 'owned controlled transport',
  lifecycle: 'current',
  maxInputTokens: 100000,
  maxOutputTokens: 4096,
  boundedDecision: true,
};
const bundle = modelBundleSchema.parse({
  format: 1,
  id: 'task-progress',
  mapping: {
    ...initialModelMapping,
    revision: 'task-progress',
    families: initialModelMapping.families.filter(family => family.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [route],
});
async function until(read, predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${JSON.stringify(value)}`);
    await delay(100);
  }
}
async function stop(child, signal = 'SIGKILL') {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill(signal);
    await exited;
  }
}

test(
  'compiled task composition progresses independently of API and resumes persisted human commands',
  { timeout: 900000 },
  async t => {
    const originalEnv = process.env;
    process.env = {
      PATH: originalEnv.PATH,
      NODE_ENV: 'test',
      TEST_ADMIN_DATABASE_URL: originalEnv.TEST_ADMIN_DATABASE_URL,
      BETTER_AUTH_SECRET: 'synthetic-progress-secret-at-least-32-characters',
      BETTER_AUTH_URL: 'http://127.0.0.1:3001',
      WEB_ORIGIN: 'http://localhost:5173',
      TEMPORAL_ADDRESS: originalEnv.TASK_TEST_TEMPORAL_ADDRESS,
      TEMPORAL_TASK_QUEUE: `task-progress-${randomUUID()}`,
      WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
      WORKSPACE_RUNTIME_REPLICAS: '1',
      WORKSPACE_DATABASE_CONNECTION_BUDGET: '120',
      WORKSPACE_RUNTIME_KEY_ID: 'test',
      WORKSPACE_RUNTIME_KEY: '11'.repeat(32),
      INTEGRATION_CREDENTIAL_KEY_ID: 'test',
      INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
      EMAIL_DELIVERY_KEY_ID: 'test',
      EMAIL_DELIVERY_KEY: '44'.repeat(32),
    };
    const db = await fixture();
    let runtime, identity, provider, connection;
    const apis = [],
      workers = [];
    t.after(async () => {
      for (const child of [...apis, ...workers]) await stop(child);
      await connection?.close();
      await runtime?.close();
      await identity?.end();
      if (provider) await new Promise(resolve => provider.close(resolve));
      try {
      } finally {
        await db.close();
        process.env = originalEnv;
      }
    });
    await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
    for (const name of ['0001_baseline.sql'])
      await db.platform.query(
        await readFile(new URL(`../../../apps/database/migrations/${name}`, import.meta.url), 'utf8'),
      );
    identity = new Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
    const links = [],
      auth = createAuth(
        identity,
        async ({ url }) => links.push(url),
        async () => {},
      );
    await auth.api.signInMagicLink({
      headers: new Headers({ origin: process.env.WEB_ORIGIN }),
      body: { email: `${randomUUID()}@example.com`, name: 'Task owner' },
    });
    const response = await auth.handler(new Request(links.pop()));
    const cookie = response.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    const user = (await auth.api.getSession({ headers: new Headers({ cookie }) })).user.id;
    const stream = await workspaceTableMigrations(),
      w = await db.create(stream),
      table = name => `"${w.names.schema}"."${name}"`,
      member = randomUUID();
    process.env.DATABASE_URL = db.connectionString;
    process.env.WORKSPACE_CONFIRMATION_KEY_ID = 'test';
    process.env.WORKSPACE_CONFIRMATION_KEY = '22'.repeat(32);
    process.env.WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL = db.login(w, 'confirmation');
    await identity.query(
      `INSERT INTO app.workspaces(id,request_id,created_by,name,slug,soul_commit,soul_bucket,soul_key,ready_at) VALUES($1,$2,$3,'Progress','progress',$4,'fixture','fixture',now()) ON CONFLICT (id) DO UPDATE SET soul_commit=excluded.soul_commit,soul_bucket=excluded.soul_bucket,soul_key=excluded.soul_key,ready_at=excluded.ready_at`,
      [w.id, randomUUID(), user, 'a'.repeat(40)],
    );
    const credential = encryptCredential(
      db.login(w),
      { workspaceId: w.id, generation: 1, capability: 'runtime' },
      { keyId: 'test', key: Buffer.from('11'.repeat(32), 'hex') },
    );
    const confirmationCredential = encryptCredential(
      db.login(w, 'confirmation'),
      { workspaceId: w.id, generation: 1, capability: 'confirmation' },
      { keyId: 'test', key: Buffer.from('22'.repeat(32), 'hex') },
    );
    await identity.query(
      `INSERT INTO app.workspace_storage(workspace_id,stage,runtime_credential,migration_credential,confirmation_credential) VALUES($1,'ready',$2,'{}',$3) ON CONFLICT (workspace_id) DO UPDATE SET stage=excluded.stage,runtime_credential=excluded.runtime_credential,migration_credential=excluded.migration_credential,confirmation_credential=excluded.confirmation_credential`,
      [w.id, credential, confirmationCredential],
    );
    await db.platform.query(
      `GRANT USAGE ON SCHEMA app TO "${w.names.confirmation}"; GRANT SELECT(workspace_id,generation,stage,confirmation_credential) ON app.workspace_storage TO "${w.names.confirmation}"`,
    );
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    assert.equal(
      (await db.platform.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table('tf_slack_actions')])).rows[0]
        .installed,
      true,
    );
    assert.deepEqual(await createTaskProgress(runtime)(w.id, randomUUID()), { kind: 'terminal' });
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member,
      user,
    ]);
    const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['rows.get', 'rows.update']);
    const name = textField(),
      fieldId = name.id,
      recordId = randomUUID(),
      revision = 'a'.repeat(40);
    const { tableId } = await createTableWithRows({
      db,
      workspace: w,
      runtime,
      revision,
      definition: tableDefinition({ owningTeamId: agent.teamId, label: 'Private contacts', fields: [name] }),
      records: [{ id: recordId, values: textValues(name, 'PRIVATE_RECORD_CANARY') }],
    });
    const permissions = ['table.row.read', 'table.row.update', 'table.row.create'],
      scope = [{ assetId: tableId, permissions }];
    for (const permission of permissions)
      await db.platform.query(`INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
        agent.teamId,
        tableId,
        permission,
      ]);
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
      agent.activationId,
      JSON.stringify(scope),
    ]);
    await createAgentExecutor({ runtime }).configure(
      w.id,
      { kind: 'human', userId: w.userId, membershipId: w.membershipId },
      { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: scope },
    );
    const records = createAgentRecordTools(runtime),
      tasks = createAgentTasks(runtime),
      progress = createTaskProgress(runtime),
      approvals = createTaskApprovals(runtime);
    const decide = createTaskApprovalDecision({
      runtime,
      resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
    });
    const get = { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId };
    const update = {
      tool: 'rows.update',
      tableId,
      expectedAppliedRevision: revision,
      recordId,
      values: { [fieldId]: text('Alice') },
    };
    const requests = [],
      requestTimes = [];
    let choose = async context =>
      context.results.length
        ? { kind: 'answer', text: 'PRIVATE_COMPLETION_CANARY' }
        : { kind: 'tool', text: 'PRIVATE_DECISION_CANARY', call: get };
    provider = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const context = JSON.parse(body.messages.at(-1).content);
      requests.push(context);
      requestTimes.push(performance.now());
      const decision = await choose(context);
      const selected =
        decision.kind === 'tool'
          ? { calls: [useCall(decision.call, decision.text)] }
          : decision.kind === 'propose'
            ? { calls: decision.calls.map(call => useCall(call, decision.text)) }
            : { text: decision.text };
      const result = nativeReply('anthropic', selected);
      // The runtime fails generations whose reported model is not the configured one.
      result.model = body.model;
      result.usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      response.writeHead(200, { 'content-type': 'application/json', 'request-id': randomUUID() });
      response.end(JSON.stringify(result));
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
    const client = new Client({ connection });
    const workflowId = id => `agent-task-v1-${w.id}-${id}`;
    const handle = id => client.workflow.getHandle(workflowId(id));
    const wake = id =>
      client.workflow.signalWithStart('agentTaskStep', {
        workflowId: workflowId(id),
        taskQueue: process.env.TEMPORAL_TASK_QUEUE,
        args: [w.id, id],
        signal: 'wakeAgentTask',
        signalArgs: [],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      });
    const state = id => tasks.read(w.id, user, id);
    const calls = async id =>
      (
        await db.platform.query(
          `SELECT c.status,c.result FROM ${table('tf_agent_tool_calls')} c JOIN ${table('tf_agent_task_runs')} r ON r.run_id=c.run_id WHERE r.task_id=$1 ORDER BY c.sequence`,
          [id],
        )
      ).rows;
    async function startApi() {
      const child = fork(new URL('../../../apps/api/test/task-progress-process.mjs', import.meta.url), [], {
        // The API validates the model catalog at startup, so it needs the same served model as the worker.
        env: { ...process.env, MODEL_CATALOG: modelCatalogOf(['claude-opus']), ANTHROPIC_API_KEY: 'synthetic-only' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      apis.push(child);
      const [message] = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(([code]) => {
          throw new Error(`API exited ${code}`);
        }),
      ]);
      return { child, address: message.address };
    }
    async function startWorker(holdFirst = false, lateAccountingRollback = false) {
      const child = fork(new URL('../../../apps/worker/test/task-progress-process.mjs', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: {
          PATH: originalEnv.PATH,
          MODEL_CATALOG: modelCatalogOf(['claude-opus']),
          ANTHROPIC_API_KEY: 'synthetic-only',
          TASK_PROGRESS_INPUT: JSON.stringify({
            address: process.env.TEMPORAL_ADDRESS,
            queue: process.env.TEMPORAL_TASK_QUEUE,
            workspaceId: w.id,
            runtime: db.login(w),
            provider: `http://127.0.0.1:${provider.address().port}/v1/messages`,
            holdFirst,
            lateAccountingRollback,
          }),
        },
      });
      workers.push(child);
      const messages = [];
      child.on('message', message => messages.push(message));
      // Worker.create bundles the workflows with webpack, which alone can exceed the step budget on a loaded host.
      await until(
        () => {
          assert.equal(child.exitCode ?? child.signalCode, null, 'worker exited before it was ready');
          return messages;
        },
        rows => rows.some(row => row.ready),
        180000,
      );
      return { child, messages };
    }
    async function startHttp(api, text) {
      const response = await fetch(`${api.address}/v1/workspaces/${w.id}/agent-tasks`, {
        method: 'POST',
        headers: { cookie, origin: process.env.WEB_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: randomUUID(), agentId: agent.agentId, scope, text }),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    }
    async function commandHttp(api, taskId, suffix, body) {
      const response = await fetch(`${api.address}/v1/workspaces/${w.id}/agent-tasks/${taskId}/${suffix}`, {
        method: 'POST',
        headers: { cookie, origin: process.env.WEB_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    }
    async function assertPrivateHistory(id) {
      const history = JSON.stringify(await handle(id).fetchHistory(), (_key, value) =>
        value instanceof Uint8Array
          ? Buffer.from(value).toString('utf8')
          : value?.type === 'Buffer' && Array.isArray(value.data)
            ? Buffer.from(value.data).toString('utf8')
            : value,
      );
      for (const canary of [
        'PRIVATE_RECORD_CANARY',
        'PRIVATE_COMPLETION_CANARY',
        'PRIVATE_DECISION_CANARY',
        'PRIVATE_OWNER_CANARY',
        'STALE_GENERATION_CANARY',
        'Use title case.',
        'Change to Alice.',
      ])
        assert.equal(history.includes(canary), false, canary);
      assert.ok(history.includes(w.id));
      assert.ok(history.includes(id));
      assert.ok(history.includes('processAgentTaskStep'));
    }

    await t.test(
      'API death after decision persistence leaves worker able to read and infer to completion',
      async () => {
        const worker = await startWorker(true),
          api = await startApi();
        const startedAt = performance.now();
        const next = await startHttp(api, 'PRIVATE_OWNER_CANARY');
        await until(
          () => worker.messages,
          rows => rows.some(row => row.boundary === 'step-persisted'),
        );
        assert.equal((await calls(next.id))[0].status, 'pending');
        await stop(api.child);
        worker.child.send({ release: true });
        await until(
          () => state(next.id),
          value => value.status === 'completed',
        );
        await handle(next.id).result();
        assert.equal(worker.child.exitCode, null);
        assert.equal(worker.child.signalCode, null);
        assert.equal(requests.length, 2);
        assert.equal(requests[1].results[0].result.values[fieldId].value, 'PRIVATE_RECORD_CANARY');
        console.log(
          JSON.stringify({
            measurement: 'HTTP task start to first model request',
            milliseconds: Math.round(requestTimes[0] - startedAt),
          }),
        );
        assert.equal((await calls(next.id))[0].status, 'completed');
        assert.equal((await tasks.history(w.id, user, next.id)).messages.at(-1).text, 'PRIVATE_COMPLETION_CANARY');
        await assertPrivateHistory(next.id);
        await stop(worker.child, 'SIGTERM');
      },
    );

    await t.test('approval waits stop discovery churn, then resume once with competing APIs', async () => {
      choose = async context => {
        if (!context.results.length) return { kind: 'tool', text: 'PRIVATE_DECISION_CANARY', call: get };
        if (!context.results.some(result => result.call.tool === 'rows.update'))
          return {
            kind: 'propose',
            text: 'Change to Alice.',
            calls: [
              {
                ...update,
                expectedToken: context.results.findLast(result => result.call.tool === 'rows.get').result.token,
              },
            ],
          };
        assert.equal(context.results.at(-1).result.values[fieldId].value, 'Alice');
        return { kind: 'answer', text: 'PRIVATE_COMPLETION_CANARY' };
      };
      const worker = await startWorker(),
        api = await startApi(),
        otherApi = await startApi();
      const next = await startHttp(api, 'Clean the private contact.');
      await until(
        () => state(next.id),
        value => value.status === 'waiting-clarification',
      );
      assert.deepEqual(await progress(w.id, next.id), { kind: 'waiting' });
      const waitingRun = (await handle(next.id).describe()).runId;
      await delay(4500);
      assert.equal((await handle(next.id).describe()).runId, waitingRun);
      const history = await tasks.history(w.id, user, next.id),
        reply = {
          requestId: randomUUID(),
          expectedGeneration: 0,
          expectedSequence: history.messages.at(-1).sequence,
          text: 'Use title case.',
        };
      await Promise.all([
        commandHttp(api, next.id, 'continue', reply),
        commandHttp(otherApi, next.id, 'continue', reply),
      ]);
      await until(
        () => state(next.id),
        value => value.status === 'waiting-approval',
      );
      assert.deepEqual(await progress(w.id, next.id), { kind: 'waiting' });
      const approvalRun = (await handle(next.id).describe()).runId;
      assert.equal(approvalRun, waitingRun);
      await delay(4500);
      assert.equal((await handle(next.id).describe()).runId, approvalRun);
      assert.equal(
        (await records.getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value,
        'PRIVATE_RECORD_CANARY',
      );
      const proposalId = (await approvals.list(w.id, user, next.id)).proposals[0].id;
      const proposal = await approvals.read(w.id, user, next.id, proposalId);
      const decision = { digest: proposal.digest, decision: 'approve' };
      await Promise.all([
        commandHttp(api, next.id, `proposals/${proposalId}/decision`, decision),
        commandHttp(otherApi, next.id, `proposals/${proposalId}/decision`, decision),
      ]);
      await until(
        () => state(next.id),
        value => value.status === 'completed',
      );
      await handle(next.id).result();
      assert.equal((await records.getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value, 'Alice');
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::integer AS n FROM ${table('tf_agent_task_action_receipts')} WHERE call_id=$1`,
            [proposal.actions[0].id],
          )
        ).rows[0].n,
        1,
      );
      await assertPrivateHistory(next.id);
      const before = await state(next.id),
        reopen = { requestId: randomUUID(), expectedGeneration: 0, text: 'Check again.' };
      choose = async () => ({ kind: 'answer', text: 'Follow-up complete.' });
      await Promise.all([
        commandHttp(api, next.id, 'reopen', reopen),
        commandHttp(otherApi, next.id, 'reopen', reopen),
      ]);
      await until(
        () => state(next.id),
        value => value.status === 'completed' && value.generation === 1,
      );
      await handle(next.id).result();
      const after = await state(next.id);
      assert.equal(after.flowId, before.flowId);
      assert.equal(after.definitionRevision, before.definitionRevision);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::integer AS n FROM ${table('tf_agent_task_runs')} WHERE task_id=$1 AND generation=1`,
            [next.id],
          )
        ).rows[0].n,
        1,
      );
      await stop(api.child);
      await stop(otherApi.child);
      await stop(worker.child, 'SIGTERM');
    });

    await t.test('killed worker retries a committed decision without API or duplicate selection', async () => {
      choose = async context =>
        context.results.length
          ? { kind: 'answer', text: 'Recovered worker.' }
          : { kind: 'tool', text: 'PRIVATE_DECISION_CANARY', call: get };
      const before = requests.length,
        worker = await startWorker(true),
        api = await startApi();
      const next = await startHttp(api, 'Recover after worker death.');
      await until(
        () => worker.messages,
        rows => rows.some(row => row.boundary === 'step-persisted'),
      );
      await stop(api.child);
      await stop(worker.child);
      const replacement = await startWorker();
      await until(
        () => state(next.id),
        value => value.status === 'completed',
        80000,
      );
      await handle(next.id).result();
      assert.equal(requests.length - before, 2);
      assert.equal((await calls(next.id)).length, 1);
      assert.equal((await calls(next.id))[0].status, 'completed');
      await assertPrivateHistory(next.id);
      await stop(replacement.child, 'SIGTERM');
    });

    await t.test('compiled API and worker automatically settle paused late accounting after rollback', async () => {
      const release = Promise.withResolvers(),
        entered = Promise.withResolvers();
      choose = async () => {
        entered.resolve();
        return release.promise;
      };
      const before = requests.length;
      const next = await tasks.start(w.id, user, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        scope,
        text: 'Recover accounting without continuation.',
        limits: { toolCalls: 10, credits: 100, activeMilliseconds: 4000 },
      });
      const worker = await startWorker(false, next.id);
      await wake(next.id);
      const api = await startApi(),
        otherApi = await startApi();
      try {
        await Promise.race([
          entered.promise,
          delay(15000).then(() => {
            throw new Error('Provider was not dispatched');
          }),
        ]);
        await until(
          () => state(next.id),
          value => value.status === 'paused',
        );
        const pausedRun = (await handle(next.id).describe()).runId;
        assert.deepEqual((await state(next.id)).cost, { chargedCreditUnits: '0', heldCreditUnits: '20000000000000' });
        release.resolve({ kind: 'answer', text: 'PRIVATE_LOST_ACCOUNTING_DECISION' });
        await until(
          () => worker.messages,
          rows => rows.some(row => row.boundary === 'accounting-rollback'),
        );
        await stop(api.child);
        await stop(otherApi.child);
        const settled = await until(
          () => state(next.id),
          value => value.cost.heldCreditUnits === '0',
          80000,
        );
        assert.deepEqual(settled.cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '0' });
        assert.equal(settled.status, 'paused');
        assert.equal(settled.toolCalls, 0);
        assert.deepEqual(await calls(next.id), []);
        assert.equal(requests.length - before, 1);
        assert.equal(
          (await tasks.history(w.id, user, next.id)).messages.some(
            message => message.text === 'PRIVATE_LOST_ACCOUNTING_DECISION',
          ),
          false,
        );
        const recoveredRun = (await handle(next.id).describe()).runId;
        assert.equal(recoveredRun, pausedRun);
        const processed = worker.messages.filter(message => message.processed === next.id).length;
        await delay(4500);
        assert.equal((await handle(next.id).describe()).runId, recoveredRun);
        assert.equal(worker.messages.filter(message => message.processed === next.id).length, processed);
        assert.deepEqual((await state(next.id)).cost, settled.cost);
        assert.equal((await state(next.id)).activeMilliseconds, settled.activeMilliseconds);
        assert.equal(requests.length - before, 1);
        const history = JSON.stringify(await handle(next.id).fetchHistory());
        assert.equal(history.includes('PRIVATE_LOST_ACCOUNTING_DECISION'), false);
      } finally {
        release.resolve({ kind: 'answer', text: 'Never publish.' });
        await stop(api.child);
        await stop(otherApi.child);
        await stop(worker.child, 'SIGTERM');
      }
    });

    await t.test('live model lease uses durable backoff and stale generation cannot publish', async () => {
      const next = await tasks.start(w.id, user, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        scope,
        text: 'Lease and generation fencing.',
      });
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      const model = {
        activeBundle: () => ({ bundle, activationRevision: 1 }),
        restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
        trustedBundle: () => bundle,
        allowed: () => true,
        actualModelIds: () => [route.modelId],
        health: createModelRouteHealth(identity, () => 'task-progress-lease'),
        budgetPicoUsd: () => '10000000000000',
        defaultFamily: () => 'claude-opus',
        infer: async () => {
          entered.resolve();
          await release.promise;
          return {
            kind: 'success',
            decision: { kind: 'answer', text: 'STALE_GENERATION_CANARY' },
            actualModel: route.modelId,
            requestId: randomUUID(),
            usage: {
              kind: 'known',
              input: 10,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
          };
        },
      };
      const inflight = createTaskRuntime(runtime, model).process(w.id, next.id);
      await entered.promise;
      const worker = await startWorker(),
        api = await startApi();
      await wake(next.id);
      try {
        await until(
          () => worker.messages.filter(message => message.processed === next.id),
          rows => rows.length >= 2,
          80000,
        );
        const before = requests.length;
        const history = await handle(next.id).fetchHistory();
        assert.ok(history.events.filter(event => event.timerStartedEventAttributes).length >= 1);
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::integer AS n FROM ${table('tf_model_attempts')} a JOIN ${table('tf_agent_task_runs')} r ON r.run_id=a.run_id WHERE r.task_id=$1`,
              [next.id],
            )
          ).rows[0].n,
          1,
        );
        await stop(api.child);
        // Fault injection simulates a generation change before the original model returns.
        await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET generation=generation+1 WHERE id=$1`, [next.id]);
        release.resolve();
        await inflight;
        assert.equal(
          (await tasks.history(w.id, user, next.id)).messages.some(
            message => message.text === 'STALE_GENERATION_CANARY',
          ),
          false,
        );
        assert.equal((await state(next.id)).status, 'failed');
        await handle(next.id).result();
        const retained = await tasks.history(w.id, user, next.id);
        choose = async () => ({ kind: 'answer', text: 'Current generation completed.' });
        const recoveryApi = await startApi();
        await commandHttp(recoveryApi, next.id, 'continue', {
          requestId: randomUUID(),
          expectedGeneration: 1,
          expectedSequence: retained.messages.at(-1).sequence,
          text: 'Resume current generation.',
        });
        await until(
          () => state(next.id),
          value => value.status === 'completed' && value.generation === 1,
        );
        await handle(next.id).result();
        assert.equal(requests.length - before, 1);
        assert.equal((await tasks.history(w.id, user, next.id)).messages.at(-1).text, 'Current generation completed.');
        await assertPrivateHistory(next.id);
        await stop(recoveryApi.child);
      } finally {
        release.resolve();
        await inflight;
        await stop(api.child);
        await stop(worker.child, 'SIGTERM');
      }
    });

    await t.test('persisted owner reply survives USE_EXISTING while the waiting execution ends', async () => {
      choose = async context =>
        context.history.some(message => message.text === 'Reply before workflow closes.')
          ? { kind: 'answer', text: 'Completion race recovered.' }
          : { kind: 'clarify', text: 'Waiting at completion boundary.' };
      const worker = await startWorker(true),
        api = await startApi();
      const next = await startHttp(api, 'Exercise the completion race.');
      await until(
        () => worker.messages,
        rows => rows.some(row => row.boundary === 'step-persisted'),
      );
      assert.equal((await state(next.id)).status, 'waiting-clarification');
      assert.deepEqual(worker.messages.find(message => message.processed === next.id).result, { kind: 'waiting' });
      const original = await handle(next.id).describe();
      assert.equal(original.status.name, 'RUNNING');
      const history = await tasks.history(w.id, user, next.id);
      const reply = {
        requestId: randomUUID(),
        expectedGeneration: 0,
        expectedSequence: history.messages.at(-1).sequence,
        text: 'Reply before workflow closes.',
      };
      await Promise.all([commandHttp(api, next.id, 'continue', reply), commandHttp(api, next.id, 'continue', reply)]);
      assert.deepEqual(await progress(w.id, next.id), { kind: 'runnable' });
      const duplicate = await client.workflow.start('agentTaskStep', {
        workflowId: workflowId(next.id),
        taskQueue: process.env.TEMPORAL_TASK_QUEUE,
        args: [w.id, next.id],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      });
      assert.equal(duplicate.firstExecutionRunId, original.runId);
      await delay(4500);
      assert.equal((await handle(next.id).describe()).runId, original.runId);
      assert.equal(worker.messages.filter(message => message.processed === next.id).length, 1);
      worker.child.send({ release: true });
      await until(
        () => state(next.id),
        value => value.status === 'completed',
      );
      await handle(next.id).result();
      const final = await handle(next.id).describe();
      assert.equal(final.runId, original.runId);
      assert.equal(final.workflowId, workflowId(next.id));
      const retained = await tasks.history(w.id, user, next.id);
      assert.equal(retained.messages.filter(message => message.text === reply.text).length, 1);
      assert.equal(retained.messages.at(-1).text, 'Completion race recovered.');
      await stop(api.child);
      await stop(worker.child, 'SIGTERM');
    });

    await t.test('scheduling follows rejected and recovered proposals rather than the task status alone', async () => {
      const next = await tasks.start(w.id, user, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        scope,
        text: 'Review the exact update.',
      });
      choose = async () => ({
        kind: 'propose',
        text: 'Change to Alice.',
        calls: [{ ...update, expectedToken: (await records.getRecord(w.id, user, tableId, revision, recordId)).token }],
      });
      const worker = await startWorker(),
        api = await startApi();
      await wake(next.id);
      await until(
        () => state(next.id),
        value => value.status === 'waiting-approval',
      );
      await stop(api.child);
      await stop(worker.child, 'SIGTERM');
      const original = await approvals.read(
        w.id,
        user,
        next.id,
        (await approvals.list(w.id, user, next.id)).proposals[0].id,
      );
      await decide(w.id, user, next.id, original.id, { digest: original.digest, decision: 'approve' });
      await records.updateRecord(
        w.id,
        user,
        tableId,
        revision,
        recordId,
        { [fieldId]: text('Changed after approval.') },
        (await records.getRecord(w.id, user, tableId, revision, recordId)).token,
      );
      const executor = createAgentExecutor({ runtime });
      assert.equal(
        await executor.execute({ workspaceId: w.id, runId: original.runId, callId: original.actions[0].id }),
        'failed',
      );
      assert.deepEqual(await progress(w.id, next.id), { kind: 'waiting' });
      const recovered = await approvals.recover(w.id, user, next.id, original.id, {
        requestId: randomUUID(),
        generation: 0,
      });
      assert.deepEqual(await progress(w.id, next.id), { kind: 'waiting' });
      await decide(w.id, user, next.id, recovered.id, { digest: recovered.digest, decision: 'reject' });
      assert.deepEqual(await progress(w.id, next.id), { kind: 'runnable' });
      choose = async () => ({ kind: 'answer', text: 'Rejected changes were not executed.' });
      const replacement = await startWorker(),
        discovery = await startApi();
      await wake(next.id);
      await until(
        () => state(next.id),
        value => value.status === 'completed',
      );
      await handle(next.id).result();
      assert.equal(
        (await records.getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value,
        'Changed after approval.',
      );
      assert.deepEqual(await progress(w.id, next.id), { kind: 'terminal' });
      await stop(discovery.child);
      await stop(replacement.child, 'SIGTERM');
    });

    await t.test('HTTP dispatch latency samples use the first real model request', async () => {
      choose = async () => ({ kind: 'answer', text: 'Latency sample completed.' });
      const worker = await startWorker(),
        api = await startApi(),
        latencies = [];
      for (let sample = 0; sample < 5; sample++) {
        const index = requests.length,
          startedAt = performance.now();
        const next = await startHttp(api, `Dispatch latency sample ${sample}`);
        await until(
          () => state(next.id),
          value => value.status === 'completed',
        );
        await handle(next.id).result();
        assert.equal(requests.length, index + 1);
        latencies.push(Math.round(requestTimes[index] - startedAt));
      }
      console.log(
        JSON.stringify({
          measurement: 'HTTP task start to first model request',
          samples: latencies,
          medianMilliseconds: [...latencies].sort((a, b) => a - b)[2],
        }),
      );
      await stop(api.child);
      await stop(worker.child, 'SIGTERM');
    });

    await t.test('worker recovery starts a committed task with no API or command wake', async () => {
      choose = async () => ({ kind: 'answer', text: 'Recovered missed dispatch.' });
      const next = await tasks.start(w.id, user, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        scope,
        text: 'Persisted before dispatch.',
      });
      const worker = await startWorker();
      await until(
        () => state(next.id),
        value => value.status === 'completed',
        80000,
      );
      await handle(next.id).result();
      assert.equal((await tasks.history(w.id, user, next.id)).messages.at(-1).text, 'Recovered missed dispatch.');
      await stop(worker.child, 'SIGTERM');
    });
  },
);
