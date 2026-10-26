import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker, NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableWithRows, tableDefinition, textField, text, textValues } from '../../tables/test/fixture.mjs';
import { createAgentRecordTools } from '../src/record-tools.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createTaskProgress } from '../src/task-progress.ts';
import { createTaskApprovals, createTaskApprovalDecision } from '../src/task-approvals.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { createConversations } from '../../conversations/src/index.ts';
import { createAttachments } from '../../conversations/src/attachments.ts';
import { createHash } from 'node:crypto';
import { nativeReply } from './native-fixture.mjs';
import { createTaskComposition } from '../../../apps/worker/dist/task-composition.js';
import { createServer } from 'node:http';
import { modelCatalogOf } from '../../../apps/worker/test/model-catalog-fixture.mjs';
import { registerExtension } from '@tulipfarm/extensions';
import { hostedCreditPricingExtension } from '../../workspace-storage/test/hosted-credit-pricing.mjs';

// Cost assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

const route = {
  id: 'task-test',
  modelId: 'claude-opus-5-5',
  provider: 'anthropic',
  deployment: 'claude-opus-5-5',
  location: 'test',
  adapterVersion: 1,
  qualification: 'local scripted protocol only',
  lifecycle: 'current',
  maxInputTokens: 100000,
  maxOutputTokens: 4096,
  boundedDecision: true,
};
const bundle = modelBundleSchema.parse({
  format: 1,
  id: 'task-test',
  mapping: {
    ...initialModelMapping,
    revision: 'task-test',
    families: initialModelMapping.families.filter(family => family.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [route],
});
test('adaptive task uses persisted reads, owner clarification, exact approval and retained cost', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations()),
    table = name => `"${w.names.schema}".${name}`;
  const open = () =>
    createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
  runtime = open();
  const user = randomUUID(),
    member = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['rows.get', 'rows.update', 'web.fetch']);
  const name = textField(),
    fieldId = name.id,
    revision = 'a'.repeat(40),
    recordId = randomUUID();
  const { tableId } = await createTableWithRows({
    db,
    workspace: w,
    runtime,
    revision,
    definition: tableDefinition({ owningTeamId: agent.teamId, label: 'Contacts', fields: [name] }),
    records: [{ id: recordId, values: textValues(name, ' alice ') }],
  });
  for (const permission of ['table.row.read', 'table.row.update', 'table.row.create'])
    await db.platform.query(`INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
      agent.teamId,
      tableId,
      permission,
    ]);
  const scope = [{ assetId: tableId, permissions: ['table.row.read', 'table.row.update'] }];
  await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
    agent.activationId,
    JSON.stringify(scope),
  ]);
  await createAgentExecutor({ runtime }).configure(
    w.id,
    { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: scope },
  );
  const tasks = createAgentTasks(runtime);
  let selections = 0;
  const infer = async (_resolution, input) => {
    selections++;
    assert.equal(input.definition.instructions.includes('Reviewed definition'), true);
    assert.equal(input.task, true);
    const context = JSON.parse(input.prompt);
    let decision;
    if (!context.results.length)
      decision = {
        kind: 'tool',
        text: 'Inspect the contact.',
        call: { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId },
      };
    else if (context.results.length === 1)
      decision = {
        kind: 'tool',
        text: 'Recheck the observed contact.',
        call: { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId: context.results[0].result.id },
      };
    else if (!context.history.some(m => m.role === 'owner' && m.text === 'Use title case.')) {
      assert.equal(context.results[0].result.values[fieldId].value, ' alice ');
      decision = { kind: 'clarify', text: 'Should I use title case?' };
    } else if (!context.results.some(r => r.call.tool === 'rows.update'))
      decision = {
        kind: 'propose',
        text: 'Change the name to Alice.',
        calls: [
          {
            tool: 'rows.update',
            tableId,
            expectedAppliedRevision: revision,
            recordId,
            expectedToken: context.results[1].result.token,
            values: { [fieldId]: text('Alice') },
          },
        ],
      };
    else {
      assert.equal(context.results.at(-1).status, 'completed');
      decision = { kind: 'answer', text: 'The name is now Alice.' };
    }
    return {
      kind: 'success',
      decision,
      actualModel: route.modelId,
      requestId: randomUUID(),
      usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    };
  };
  const model = {
    activeBundle: () => ({ bundle, activationRevision: 1 }),
    restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
    trustedBundle: () => bundle,
    allowed: () => true,
    actualModelIds: () => [route.modelId],
    health: createModelRouteHealth(db.platform, () => 'task-test'),
    infer,
    budgetPicoUsd: () => '10000000000000',
    defaultFamily: () => 'claude-opus',
  };
  let engine = createTaskRuntime(runtime, model);
  const task = await tasks.start(w.id, user, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    scope,
    text: 'Clean the contact name.',
    limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
  });
  await engine.process(w.id, task.id);
  assert.equal(selections, 1);
  await runtime.close();
  runtime = open();
  engine = createTaskRuntime(runtime, model);
  await engine.process(w.id, task.id);
  assert.equal(selections, 1, 'restart executes persisted decision without inference replay');
  await engine.process(w.id, task.id);
  await engine.process(w.id, task.id);
  await engine.process(w.id, task.id);
  const service = createAgentTasks(runtime);
  assert.equal((await service.read(w.id, user, task.id)).status, 'waiting-clarification');
  await engine.process(w.id, task.id);
  assert.equal(selections, 3);
  const history = await service.history(w.id, user, task.id);
  const reply = {
    requestId: randomUUID(),
    expectedGeneration: 0,
    expectedSequence: history.messages.at(-1).sequence,
    text: 'Use title case.',
  };
  await assert.rejects(service.continueTask(w.id, w.userId, task.id, reply));
  assert.deepEqual(
    await service.continueTask(w.id, user, task.id, reply),
    await service.continueTask(w.id, user, task.id, reply),
  );
  await engine.process(w.id, task.id);
  assert.equal((await service.read(w.id, user, task.id)).status, 'waiting-approval');
  const approvals = createTaskApprovals(runtime);
  const [proposalStatus] = (await approvals.list(w.id, user, task.id)).proposals;
  const proposal = await approvals.read(w.id, user, task.id, proposalStatus.id);
  assert.equal(proposal.actions[0].before.values[fieldId].value, ' alice ');
  assert.equal(proposal.actions[0].after.values[fieldId].value, 'Alice');
  await engine.process(w.id, task.id);
  assert.equal(
    (await createAgentRecordTools(runtime).getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value,
    ' alice ',
  );
  const decide = createTaskApprovalDecision({
    runtime,
    resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
  });
  await decide(w.id, user, task.id, proposal.id, { digest: proposal.digest, decision: 'approve' });
  // The competing worker waits on the task lock. On a slow database it may hit the 5 s lock timeout, which the
  // activity retries; exactly-once execution is asserted from the receipts below.
  const competing = await Promise.allSettled([engine.process(w.id, task.id), engine.process(w.id, task.id)]);
  assert.ok(competing.some(outcome => outcome.status === 'fulfilled'));
  for (const outcome of competing)
    if (outcome.status === 'rejected') assert.equal(outcome.reason.code, '55P03', outcome.reason.stack);
  for (let n = 0; n < 3 && (await service.read(w.id, user, task.id)).status !== 'completed'; n++)
    await engine.process(w.id, task.id);
  assert.equal((await service.read(w.id, user, task.id)).status, 'completed');
  assert.equal(
    (await createAgentRecordTools(runtime).getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value,
    'Alice',
  );
  assert.equal(
    (
      await db.platform.query(
        `SELECT count(*)::integer AS n FROM ${table('tf_agent_task_action_receipts')} WHERE call_id=$1`,
        [proposal.actions[0].id],
      )
    ).rows[0].n,
    1,
  );
  const completed = await service.read(w.id, user, task.id);
  assert.equal(completed.cost.chargedCreditUnits, '1000000000000');
  assert.equal(completed.cost.heldCreditUnits, '0');
  assert.equal(selections, 5);
  const followup = await service.reopen(w.id, user, task.id, {
    requestId: randomUUID(),
    expectedGeneration: 0,
    text: 'Check it again.',
  });
  assert.equal(followup.generation, 1);
  const reopened = await service.read(w.id, user, task.id);
  assert.equal(reopened.flowId, completed.flowId);
  assert.equal(reopened.definitionRevision, completed.definitionRevision);
  assert.deepEqual(reopened.cost, completed.cost);
  const start = async limits =>
    service.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope,
      text: 'Inspect.',
      limits: limits ?? { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
    });
  const success = decision => ({
    kind: 'success',
    decision,
    actualModel: route.modelId,
    requestId: randomUUID(),
    usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  });
  await t.test('parallel task reads use two workers and retain one run record per call', async t => {
    const previousEndpoint = process.env.FIRECRAWL_ENDPOINT;
    process.env.FIRECRAWL_ENDPOINT = 'https://public.example/';
    t.after(() => {
      if (previousEndpoint === undefined) delete process.env.FIRECRAWL_ENDPOINT;
      else process.env.FIRECRAWL_ENDPOINT = previousEndpoint;
    });
    let active = 0,
      maximum = 0;
    const bothStarted = Promise.withResolvers();
    t.mock.method(globalThis, 'fetch', async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === 2) bothStarted.resolve();
      await Promise.race([
        bothStarted.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('parallel-read-timeout')), 2000)),
      ]);
      active--;
      return Response.json({
        success: true,
        data: { markdown: 'Synthetic public content.', metadata: { statusCode: 200 } },
      });
    });
    const parallel = await start();
    const parallelModel = {
      ...model,
      infer: async (_resolution, input) =>
        success(
          JSON.parse(input.prompt).results.length
            ? { kind: 'answer', text: 'Both pages were read.' }
            : {
                kind: 'tools',
                text: 'Read both pages.',
                calls: [
                  { activity: 'Reading the first page', call: { tool: 'web.fetch', url: 'https://example.com/first' } },
                  {
                    activity: 'Reading the second page',
                    call: { tool: 'web.fetch', url: 'https://example.org/second' },
                  },
                ],
              },
        ),
    };
    const parallelEngine = createTaskRuntime(runtime, parallelModel);
    await parallelEngine.process(w.id, parallel.id);
    const persisted = (
      await db.platform.query(
        `SELECT decision FROM ${table('tf_agent_task_steps')} WHERE run_id=(SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1)`,
        [parallel.id],
      )
    ).rows[0].decision;
    const calls = (
      await db.platform.query(
        `SELECT id,status FROM ${table('tf_agent_tool_calls')} WHERE run_id=(SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1) ORDER BY sequence`,
        [parallel.id],
      )
    ).rows;
    assert.equal(persisted.kind, 'tools');
    assert.deepEqual(
      persisted.calls.map(call => call.id),
      calls.map(call => call.id),
    );
    await parallelEngine.process(w.id, parallel.id);
    assert.equal(maximum, 2);
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT status FROM ${table('tf_agent_tool_calls')} WHERE id=ANY($1::uuid[]) ORDER BY sequence`,
          [calls.map(call => call.id)],
        )
      ).rows,
      [{ status: 'completed' }, { status: 'completed' }],
    );
    await parallelEngine.process(w.id, parallel.id);
    assert.equal((await service.read(w.id, user, parallel.id)).status, 'completed');
  });
  async function interrupt(taskId, mode) {
    const child = fork(new URL('./task-runtime-process.mjs', import.meta.url), [], {
      env: {
        ...process.env,
        TASK_PROCESS_INPUT: JSON.stringify({
          connectionString: db.login(w),
          registry: db.connectionString,
          workspaceId: w.id,
          taskId,
          mode,
          route,
        }),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    // Only a hang guard: a cold child under a loaded host can take well over 15 s to reach its boundary.
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    try {
      const event = await Promise.race([
        once(child, 'message').then(([message]) => message),
        once(child, 'exit').then(([code, signal]) => {
          throw new Error(`Process exited before boundary (code ${code}, signal ${signal})`);
        }),
      ]);
      assert.deepEqual(event, { boundary: mode === 'claim' ? 'provider-dispatched' : 'step-committed' });
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  await t.test('killed process after a persisted read commit is replay-safe', async () => {
    const next = await start();
    let calls = 0;
    const bounded = createTaskRuntime(runtime, {
      ...model,
      infer: async () => {
        calls++;
        return success({
          kind: 'tool',
          text: 'Read once.',
          call: { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId },
        });
      },
    });
    await bounded.process(w.id, next.id);
    await interrupt(next.id, 'execute');
    const rows = (
      await db.platform.query(
        `SELECT c.id,c.status,c.result FROM ${table('tf_agent_tool_calls')} c JOIN ${table('tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1`,
        [next.id],
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[0].result.values[fieldId].value, 'Alice');
    const finish = createTaskRuntime(runtime, {
      ...model,
      infer: async () => success({ kind: 'answer', text: 'Read survived restart.' }),
    });
    await finish.process(w.id, next.id);
    assert.equal((await service.read(w.id, user, next.id)).status, 'completed');
    assert.equal(calls, 1);
  });
  await t.test('killed model attempt is fenced and recovery retains unknown credit reservation', async () => {
    const next = await start();
    await interrupt(next.id, 'claim');
    const held = await service.read(w.id, user, next.id);
    assert.ok(BigInt(held.cost.heldCreditUnits) > 0n);
    const attempts = (
      await db.platform.query(
        `SELECT a.id FROM ${table('tf_model_attempts')} a JOIN ${table('tf_agent_task_runs')} b ON b.run_id=a.run_id WHERE b.task_id=$1`,
        [next.id],
      )
    ).rows;
    assert.equal(attempts.length, 1);
    await db.platform.query(
      `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [attempts[0].id],
    );
    const recovered = createTaskRuntime(runtime, {
      ...model,
      trustedBundle: id => ({ ...bundle, id, mapping: { ...bundle.mapping, revision: id } }),
      infer: async () => success({ kind: 'answer', text: 'Recovered after interrupted inference.' }),
    });
    await recovered.process(w.id, next.id);
    const after = await service.read(w.id, user, next.id);
    assert.equal(after.status, 'completed');
    assert.equal(after.cost.heldCreditUnits, held.cost.heldCreditUnits);
    assert.equal(after.cost.chargedCreditUnits, '1000000000000');
    assert.equal(
      (await db.platform.query(`SELECT status FROM ${table('tf_model_attempts')} WHERE id=$1`, [attempts[0].id]))
        .rows[0].status,
      'abandoned',
    );
  });
  await t.test(
    'real Temporal worker dispatch completes a persisted task without private history payloads',
    async () => {
      const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
      assert.ok(address, 'Owned Temporal address is required, not a skipped worker proof');
      const connection = await NativeConnection.connect({ address });
      const clientConnection = await Connection.connect({ address });
      const queue = `task-runtime-${randomUUID()}`;
      const worker = await Worker.create({
        connection,
        taskQueue: queue,
        workflowsPath: fileURLToPath(new URL('../../../apps/worker/dist/workflows.js', import.meta.url)),
        activities: {
          processAgentTaskStep: async (workspaceId, taskId) => {
            await createTaskRuntime(runtime, {
              ...model,
              infer: async () => success({ kind: 'answer', text: 'PRIVATE TASK COMPLETION' }),
            }).process(workspaceId, taskId);
            return createTaskProgress(runtime)(workspaceId, taskId);
          },
        },
      });
      const running = worker.run();
      try {
        const next = await start(),
          client = new Client({ connection: clientConnection });
        const handle = await client.workflow.start('agentTaskStep', {
          workflowId: randomUUID(),
          taskQueue: queue,
          args: [w.id, next.id],
        });
        await handle.result();
        assert.equal((await service.read(w.id, user, next.id)).status, 'completed');
        assert.equal((await service.history(w.id, user, next.id)).messages.at(-1).text, 'PRIVATE TASK COMPLETION');
        assert.equal(JSON.stringify(await handle.fetchHistory()).includes('PRIVATE TASK COMPLETION'), false);
      } finally {
        worker.shutdown();
        await running;
        await clientConnection.close();
        await connection.close();
      }
    },
  );
  await t.test('direct model mutations cannot bypass proposal admission', async () => {
    const next = await start();
    const bad = createTaskRuntime(runtime, {
      ...model,
      infer: async () =>
        success({
          kind: 'tool',
          text: 'Bypass review.',
          call: {
            tool: 'rows.update',
            tableId,
            expectedAppliedRevision: revision,
            recordId,
            values: { [fieldId]: text('BYPASS') },
          },
        }),
    });
    await bad.process(w.id, next.id);
    assert.equal((await service.read(w.id, user, next.id)).status, 'failed');
    assert.equal(
      (await createAgentRecordTools(runtime).getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value,
      'Alice',
    );
    assert.equal((await approvals.list(w.id, user, next.id)).proposals.length, 0);
  });
  await t.test('in-flight competing workers make one selection and revoked authority rejects publication', async () => {
    const next = await start();
    let called = 0,
      resolve,
      announced;
    const entered = new Promise(r => {
      announced = r;
    });
    const waiting = new Promise(r => {
      resolve = r;
    });
    const concurrent = createTaskRuntime(runtime, {
      ...model,
      infer: async () => {
        called++;
        announced();
        await waiting;
        return success({ kind: 'answer', text: 'Should not publish.' });
      },
    });
    const running = concurrent.process(w.id, next.id);
    await entered;
    await concurrent.process(w.id, next.id);
    assert.equal(called, 1);
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=clock_timestamp() WHERE id=$1`, [
      agent.activationId,
    ]);
    resolve();
    await running;
    assert.equal((await service.read(w.id, user, next.id)).status, 'failed');
    assert.equal(
      (await service.history(w.id, user, next.id)).messages.some(m => m.text === 'Should not publish.'),
      false,
    );
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=NULL WHERE id=$1`, [
      agent.activationId,
    ]);
  });
  await t.test('time limits pause before dispatch and owner continuation preserves the task', async () => {
    const next = await start({ toolCalls: 10, credits: 100, activeMilliseconds: 1000 });
    let called = 0;
    const bounded = createTaskRuntime(runtime, {
      ...model,
      infer: async () => {
        called++;
        return success({ kind: 'answer', text: 'Done after continuation.' });
      },
    });
    await bounded.process(w.id, next.id);
    assert.equal(called, 0);
    assert.equal((await service.read(w.id, user, next.id)).status, 'paused');
    const history = await service.history(w.id, user, next.id);
    const command = {
      requestId: randomUUID(),
      expectedGeneration: 0,
      expectedSequence: history.messages.at(-1).sequence,
      text: 'Continue.',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 },
    };
    await assert.rejects(
      service.continueTask(w.id, user, next.id, { ...command, limits: { ...command.limits, credits: 10001 } }),
    );
    await service.continueTask(w.id, user, next.id, command);
    await bounded.process(w.id, next.id);
    assert.equal(called, 1);
    assert.equal((await service.read(w.id, user, next.id)).status, 'completed');
  });
  await t.test('credit reservation pauses before dispatch and cannot reset prior held cost', async () => {
    const next = await start({ toolCalls: 10, credits: 1, activeMilliseconds: 600000 });
    let called = 0;
    const bounded = createTaskRuntime(runtime, {
      ...model,
      infer: async () => {
        called++;
        return success({ kind: 'answer', text: 'Budgeted.' });
      },
    });
    await bounded.process(w.id, next.id);
    await bounded.process(w.id, next.id);
    assert.equal(called, 0);
    assert.equal((await service.read(w.id, user, next.id)).status, 'paused');
    const history = await service.history(w.id, user, next.id);
    await service.continueTask(w.id, user, next.id, {
      requestId: randomUUID(),
      expectedGeneration: 0,
      expectedSequence: history.messages.at(-1).sequence,
      text: 'Allow more.',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
    });
    await bounded.process(w.id, next.id);
    assert.equal(called, 1);
    assert.equal((await service.read(w.id, user, next.id)).cost.chargedCreditUnits, '1000000000000');
  });
  await t.test('direct approved-action execution cannot exceed the task tool limit', async () => {
    const next = await start({ toolCalls: 1, credits: 100, activeMilliseconds: 600000 });
    const second = randomUUID();
    await createAgentRecordTools(runtime).createRecord(
      w.id,
      user,
      tableId,
      revision,
      { [fieldId]: text('Bob') },
      second,
    );
    const proposal = await approvals.propose(w.id, user, next.id, {
      requestId: randomUUID(),
      generation: 0,
      calls: await Promise.all(
        [recordId, second].map(async recordId => ({
          tool: 'rows.update',
          tableId,
          expectedAppliedRevision: revision,
          recordId,
          expectedToken: (await createAgentRecordTools(runtime).getRecord(w.id, user, tableId, revision, recordId))
            .token,
          values: { [fieldId]: text('Approved') },
        })),
      ),
    });
    await decide(w.id, user, next.id, proposal.id, { digest: proposal.digest, decision: 'approve' });
    const executor = createAgentExecutor({ runtime });
    const ids = index => ({ workspaceId: w.id, runId: proposal.runId, callId: proposal.actions[index].id });
    assert.equal(await executor.execute(ids(0)), 'completed');
    assert.equal(await executor.execute(ids(0)), 'completed');
    assert.equal(await executor.execute(ids(1)), 'waiting');
    assert.equal((await service.read(w.id, user, next.id)).status, 'paused');
    assert.equal((await service.read(w.id, user, next.id)).toolCalls, 1);
    assert.equal(
      (await createAgentRecordTools(runtime).getRecord(w.id, user, tableId, revision, second)).values[fieldId].value,
      'Bob',
    );
  });
  await t.test('revoked named-agent list authority fences in-flight completion', async () => {
    await db.platform.query(`UPDATE ${table('tf_teams')} SET name='Original task invokers' WHERE id=$1`, [
      agent.teamId,
    ]);
    const listAgent = await savedTaskAgent(db, w, runtime, user, member, [], ['tables.list']);
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
      listAgent.activationId,
      JSON.stringify(scope),
    ]);
    const executor = createAgentExecutor({ runtime }),
      admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
    await db.platform.query(`INSERT INTO ${table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
      listAgent.agentId,
      agent.teamId,
    ]);
    await executor.configure(w.id, admin, {
      agentId: listAgent.agentId,
      version: 0,
      enabled: true,
      teamIds: [agent.teamId],
      limits: scope,
    });
    const next = await service.start(w.id, user, {
      requestId: randomUUID(),
      agentId: listAgent.agentId,
      scope,
      text: 'List then summarize.',
    });
    const reader = createTaskRuntime(runtime, {
      ...model,
      infer: async () => success({ kind: 'tool', text: 'List resources.', call: { tool: 'tables.list' } }),
    });
    await reader.process(w.id, next.id);
    await reader.process(w.id, next.id);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const finisher = createTaskRuntime(runtime, {
      ...model,
      infer: async (_resolution, input) => {
        assert.equal(JSON.parse(input.prompt).results[0].result.tables[0].id, tableId);
        entered.resolve();
        await release.promise;
        return success({ kind: 'answer', text: 'Revoked resource name: Contacts' });
      },
    });
    const running = finisher.process(w.id, next.id);
    await entered.promise;
    await executor.configure(w.id, admin, {
      agentId: listAgent.agentId,
      version: 1,
      enabled: true,
      teamIds: [],
      limits: scope,
    });
    release.resolve();
    await running;
    assert.equal((await service.read(w.id, user, next.id)).status, 'failed');
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::integer AS n FROM ${table('tf_agent_task_messages')} WHERE task_id=$1 AND text LIKE 'Revoked resource%'`,
          [next.id],
        )
      ).rows[0].n,
      0,
    );
  });
  await t.test('server model configuration composes the task runtime with the native provider protocol', async t => {
    const before = process.env,
      requests = [];
    process.env = {
      PATH: before.PATH,
      MODEL_CATALOG: modelCatalogOf(['claude-opus']),
      ANTHROPIC_API_KEY: 'synthetic-only',
    };
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const sent = JSON.parse(Buffer.concat(chunks));
      requests.push(sent);
      const body = nativeReply('anthropic', { text: 'Confirmed through server configuration.' });
      // The runtime fails generations whose reported model is not the configured one.
      body.model = sent.model;
      body.usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const fetch = globalThis.fetch,
      urls = [];
    // Record rather than assert here: a throw inside fetch reaches the runtime as a transport error and hides the cause.
    t.mock.method(globalThis, 'fetch', (url, options) => {
      urls.push(String(url));
      return fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, options);
    });
    const composed = createTaskComposition(runtime);
    try {
      const next = await start();
      await composed.activities.processAgentTask(w.id, next.id);
      assert.deepEqual(urls, ['https://api.anthropic.com/v1/messages']);
      assert.equal((await service.read(w.id, user, next.id)).status, 'completed');
      assert.equal(requests.length, 1);
      assert.equal(
        requests[0].tools.some(tool => tool.name === 'select_action'),
        false,
      );
      assert.equal((await service.read(w.id, user, next.id)).cost.chargedCreditUnits, '1000000000000');
    } finally {
      await composed.close();
      await new Promise(resolve => server.close(resolve));
      process.env = before;
    }
  });
  await t.test(
    'attachment reads release task locks and bounded pool leases before competing proposal reads',
    async () => {
      const chats = createConversations(runtime),
        chatId = randomUUID(),
        attachmentId = randomUUID(),
        content = Buffer.from('Authorized tiny text.');
      const attachments = createAttachments(runtime, {
        putIfAbsent: async () => {},
        read: async () => content,
        remove: async () => {},
      });
      await chats.create(w.id, user, { chatId, commandId: randomUUID() });
      await attachments.reserve(w.id, user, chatId, attachmentId, {
        filename: 'tiny.txt',
        mediaType: 'text/plain',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
      await attachments.upload(w.id, user, chatId, attachmentId, content);
      await chats.send(w.id, user, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'attachment', attachmentId }],
      });
      const next = await service.start(w.id, user, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        scope,
        text: 'Read file under contention.',
        sources: [{ kind: 'attachment', conversationId: chatId, attachmentId }],
      });
      let reads = 0;
      const engine = createTaskRuntime(
        runtime,
        {
          ...model,
          infer: async (_resolution, input) => {
            assert.equal(JSON.parse(input.prompt).files[0].text, content.toString());
            return success({ kind: 'answer', text: 'Read with the bounded pool.' });
          },
        },
        async input => {
          const competing = approvals.list(w.id, user, next.id);
          await new Promise(resolve => setTimeout(resolve, 100));
          const file = await attachments.download(
            input.workspaceId,
            input.userId,
            input.conversationId,
            input.attachmentId,
          );
          await competing;
          reads++;
          return { filename: file.filename, text: file.bytes.toString() };
        },
      );
      await engine.process(w.id, next.id);
      assert.equal(reads, 1);
      assert.equal((await service.read(w.id, user, next.id)).status, 'completed');
      const transient = await service.start(w.id, user, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        scope,
        text: 'Retry transient storage.',
        sources: [{ kind: 'attachment', conversationId: chatId, attachmentId }],
      });
      const failing = createTaskRuntime(runtime, model, async () => {
        throw new Error('temporary transport unavailable');
      });
      await assert.rejects(failing.process(w.id, transient.id), /temporary transport/);
      assert.equal((await service.read(w.id, user, transient.id)).status, 'pending');
      const recovered = createTaskRuntime(
        runtime,
        { ...model, infer: async () => success({ kind: 'answer', text: 'Storage recovered.' }) },
        async () => ({ filename: 'tiny.txt', text: content.toString() }),
      );
      await recovered.process(w.id, transient.id);
      assert.equal((await service.read(w.id, user, transient.id)).status, 'completed');
      const pair = await Promise.all(
        [0, 1].map(() =>
          service.start(w.id, user, {
            requestId: randomUUID(),
            agentId: agent.agentId,
            scope,
            text: 'Concurrent file read.',
            sources: [{ kind: 'attachment', conversationId: chatId, attachmentId }],
          }),
        ),
      );
      const parallel = createTaskRuntime(
        runtime,
        { ...model, infer: async () => success({ kind: 'answer', text: 'Concurrent file completed.' }) },
        async input => {
          const file = await attachments.download(
            input.workspaceId,
            input.userId,
            input.conversationId,
            input.attachmentId,
          );
          return { filename: file.filename, text: file.bytes.toString() };
        },
      );
      await Promise.all(pair.map(task => parallel.process(w.id, task.id)));
      assert.deepEqual(await Promise.all(pair.map(async task => (await service.read(w.id, user, task.id)).status)), [
        'completed',
        'completed',
      ]);
      const revoked = await service.start(w.id, user, {
          requestId: randomUUID(),
          agentId: agent.agentId,
          scope,
          text: 'Revalidate after retrieval.',
          sources: [{ kind: 'attachment', conversationId: chatId, attachmentId }],
        }),
        entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      let inferred = false;
      const recheck = createTaskRuntime(
        runtime,
        {
          ...model,
          infer: async () => {
            inferred = true;
            return success({ kind: 'answer', text: 'Must not publish.' });
          },
        },
        async input => {
          const file = await attachments.download(
            input.workspaceId,
            input.userId,
            input.conversationId,
            input.attachmentId,
          );
          entered.resolve();
          await release.promise;
          return { filename: file.filename, text: file.bytes.toString() };
        },
      );
      const processing = recheck.process(w.id, revoked.id);
      await entered.promise;
      await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=clock_timestamp() WHERE id=$1`, [
        agent.activationId,
      ]);
      release.resolve();
      await processing;
      assert.equal(inferred, false);
      assert.equal((await service.read(w.id, user, revoked.id)).status, 'failed');
      await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=NULL WHERE id=$1`, [
        agent.activationId,
      ]);
    },
  );
  await t.test('explicit past context reaches the model and source permission loss blocks it', async () => {
    const next = await service.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope,
      text: 'Use the previous outcome.',
      sources: [
        {
          kind: 'task',
          taskId: task.id,
          throughSequence: (await service.history(w.id, user, task.id)).messages.at(-1).sequence,
        },
      ],
    });
    let called = 0;
    const bounded = createTaskRuntime(runtime, {
      ...model,
      infer: async (_resolution, input) => {
        called++;
        assert.ok(JSON.parse(input.prompt).references[0].messages.some(m => m.text === 'The name is now Alice.'));
        return success({ kind: 'answer', text: 'Referenced.' });
      },
    });
    await bounded.process(w.id, next.id);
    assert.equal(called, 1);
    const denied = await service.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope,
      text: 'Try old context.',
      sources: [{ kind: 'task', taskId: task.id, throughSequence: 1 }],
    });
    await db.platform.query(
      `DELETE FROM ${table('tf_grants')} WHERE team_id=$1 AND asset_id=$2 AND permission='table.row.read'`,
      [agent.teamId, tableId],
    );
    await bounded.process(w.id, denied.id);
    assert.equal(called, 1);
    assert.equal((await service.read(w.id, user, denied.id)).status, 'failed');
  });
  await t.test('an oversized task reference pauses the task instead of failing every retry', async () => {
    let called = 0;
    const limited = createTaskRuntime(runtime, {
      ...model,
      infer: async () => {
        called++;
        return success({ kind: 'answer', text: 'Must not run.' });
      },
    });
    const source = await start();
    await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [source.id]);
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) SELECT $1,s,0,'owner','m'||s,'[]'::jsonb FROM generate_series(1,100) s`,
      [source.id],
    );
    const admitted = await service.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope,
      text: 'Use the long task.',
      sources: [{ kind: 'task', taskId: source.id, throughSequence: 99 }],
    });
    await db.platform.query(
      `UPDATE ${table('tf_agent_task_messages')} SET sources=$2 WHERE task_id=$1 AND sequence=0`,
      [admitted.id, JSON.stringify([{ kind: 'task', taskId: source.id, throughSequence: 100 }])],
    );
    await limited.process(w.id, admitted.id);
    const read = await service.read(w.id, user, admitted.id);
    assert.deepEqual(
      [read.status, read.pauseReason],
      ['paused', 'context'],
      'a task admitted before the reference limit pauses',
    );
    assert.equal(called, 0);
  });
});
