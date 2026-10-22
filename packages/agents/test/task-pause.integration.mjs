import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { reserveTaskWork, settleTaskWork } from '../src/task-activity.ts';
import { admitTaskCall } from '../src/task-approval-gate.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { savedTaskAgent } from './task-fixture.mjs';

test('pause reasons survive runtime, storage and task reads and clear on recovery', { timeout: 60000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const w = await db.create(await workspaceTableMigrations());
  const table = name => `"${w.names.schema}"."${name}"`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const agent = await savedTaskAgent(db, w, runtime, w.userId, w.membershipId, [], ['tables.list', 'rows.create']);
  await createAgentExecutor({ runtime }).configure(
    w.id,
    { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  const tasks = createAgentTasks(runtime);
  const start = (limits = {}) =>
    tasks.start(w.id, w.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Review this task.',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000, ...limits },
    });
  const read = task => tasks.read(w.id, w.userId, task.id);
  const transact = operation => runtime.transaction(w.id, commonCompatibility, operation);
  const paused = async (task, reason) => {
    const value = await read(task);
    assert.equal(value.status, 'paused');
    assert.equal(value.pauseReason, reason);
    assert.equal(
      (await tasks.list(w.id, w.userId, { limit: 100 })).tasks.find(row => row.id === task.id).pauseReason,
      reason,
    );
  };
  const route = {
    id: 'pause-test',
    modelId: 'claude-opus-5-5',
    provider: 'anthropic',
    deployment: 'claude-opus-5-5',
    location: 'test',
    adapterVersion: 1,
    qualification: 'local fixture',
    lifecycle: 'current',
    maxInputTokens: 100000,
    maxOutputTokens: 4096,
    boundedDecision: true,
  };
  const bundle = modelBundleSchema.parse({
    format: 1,
    id: 'pause-test',
    mapping: {
      ...initialModelMapping,
      revision: 'pause-test',
      families: initialModelMapping.families.filter(family => family.id === 'claude-opus'),
    },
    models: initialBundleModels,
    routes: [route],
  });
  const success = decision => ({
    kind: 'success',
    decision,
    actualModel: route.modelId,
    requestId: randomUUID(),
    usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  });
  const model = {
    activeBundle: () => ({ bundle, activationRevision: 1 }),
    trustedBundle: () => bundle,
    restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
    allowed: () => true,
    actualModelIds: () => [route.modelId],
    health: createModelRouteHealth(db.platform, () => 'pause-test'),
    budgetPicoUsd: () => '10000000000000',
    defaultFamily: () => 'claude-opus',
    infer: async () => success({ kind: 'clarify', text: 'What next?' }),
  };

  await t.test('owner pause is idempotent and continuation clears its reason', async () => {
    const task = await start();
    await tasks.pause(w.id, w.userId, task.id, { expectedGeneration: 0 });
    await paused(task, 'user');
    await tasks.pause(w.id, w.userId, task.id, { expectedGeneration: 0 });
    await tasks.continueTask(w.id, w.userId, task.id, {
      requestId: randomUUID(),
      expectedGeneration: 0,
      expectedSequence: 0,
      text: 'Continue.',
    });
    assert.equal((await read(task)).pauseReason, null);
    for (const status of ['pending', 'waiting-clarification', 'waiting-approval', 'completed', 'failed']) {
      await transact(tx =>
        tx.client.query(`UPDATE ${table('tf_agent_tasks')} SET status='paused',pause_reason='user' WHERE id=$1`, [
          task.id,
        ]),
      );
      await transact(tx =>
        tx.client.query(`UPDATE ${table('tf_agent_tasks')} SET status=$2 WHERE id=$1`, [task.id, status]),
      );
      assert.equal((await read(task)).pauseReason, null, status);
    }
  });
  await t.test('legacy rows and no-op pauses do not invent or overwrite a cause', async () => {
    const task = await start();
    await transact(tx =>
      tx.client.query(`UPDATE ${table('tf_agent_tasks')} SET status='paused' WHERE id=$1`, [task.id]),
    );
    await paused(task, null);
    await transact(tx =>
      tx.client.query(`UPDATE ${table('tf_agent_tasks')} SET pause_reason='limit.credits' WHERE id=$1`, [task.id]),
    );
    await tasks.pause(w.id, w.userId, task.id, { expectedGeneration: 0 });
    await paused(task, 'limit.credits');
  });
  await t.test('runtime distinguishes missing model, exhausted time, time headroom and tool count', async () => {
    for (const [limits, usage, reason] of [
      [{}, {}, 'model'],
      [{ activeMilliseconds: 1000 }, {}, 'limit.activeTime'],
      [{}, { active_milliseconds: 60000 }, 'limit.activeTime'],
      [{}, { tool_calls: 10 }, 'limit.toolCalls'],
    ]) {
      const task = await start(limits);
      await db.platform.query(
        `UPDATE ${table('tf_agent_tasks')} SET active_milliseconds=$2,tool_calls=$3 WHERE id=$1`,
        [task.id, usage.active_milliseconds ?? 0, usage.tool_calls ?? 0],
      );
      await createTaskRuntime(runtime, null).process(w.id, task.id);
      await paused(task, reason);
    }
  });
  await t.test('activity admission and settlement both record active-time exhaustion', async () => {
    const task = await start({ activeMilliseconds: 1000 });
    const activity = await transact(tx => reserveTaskWork(tx, task.id, 'files'));
    await transact(tx => settleTaskWork(tx, activity, 1000));
    await paused(task, 'limit.activeTime');
    await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [task.id]);
    assert.equal(await transact(tx => reserveTaskWork(tx, task.id, 'tool')), null);
    await paused(task, 'limit.activeTime');
  });
  await t.test('approval admission identifies the actual exhausted budget', async () => {
    for (const [calls, milliseconds, reason] of [
      [10, 0, 'limit.toolCalls'],
      [0, 60000, 'limit.activeTime'],
    ]) {
      const task = await start();
      await db.platform.query(
        `UPDATE ${table('tf_agent_tasks')} SET tool_calls=$2,active_milliseconds=$3 WHERE id=$1`,
        [task.id, calls, milliseconds],
      );
      assert.equal(await transact(tx => admitTaskCall(tx, task.id, randomUUID())), false);
      await paused(task, reason);
    }
  });
  await t.test('credit admission below the task cap records the credit reason', async () => {
    const task = await start({ credits: 1 });
    const engine = createTaskRuntime(runtime, model);
    await engine.process(w.id, task.id);
    await engine.process(w.id, task.id);
    await paused(task, 'limit.credits');
    assert.equal((await read(task)).cost.chargedCreditUnits, '0');
  });
  await t.test('caught configuration failure records model rather than a limit', async () => {
    const task = await start();
    await createTaskRuntime(runtime, { ...model, defaultFamily: () => undefined }).process(w.id, task.id);
    await paused(task, 'model');
  });
  await t.test('failed generations preserve each non-model cause and the hard step ceiling', async () => {
    for (const [failure, reason] of [
      ['task-credits', 'limit.credits'],
      ['credits-exhausted', 'limit.workspaceCredits'],
      ['context-overflow', 'context'],
      ['context-limit', 'context'],
      ['file-unavailable', 'file'],
      ['file-unsupported', 'file'],
      ['provider-error', 'model'],
    ]) {
      const task = await start(),
        engine = createTaskRuntime(runtime, model);
      await engine.process(w.id, task.id);
      await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [task.id]);
      await db.platform.query(
        `UPDATE ${table('tf_agent_task_steps')} SET decision=NULL,completed=false WHERE task_id=$1`,
        [task.id],
      );
      await db.platform.query(
        `UPDATE ${table('tf_model_generations')} SET status='failed',failure=$2 WHERE run_id IN (SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1)`,
        [task.id, failure],
      );
      await engine.process(w.id, task.id);
      await paused(task, reason);
    }
    const task = await start(),
      engine = createTaskRuntime(runtime, model);
    await engine.process(w.id, task.id);
    await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [task.id]);
    await db.platform.query(`UPDATE ${table('tf_agent_task_steps')} SET step=9999,completed=true WHERE task_id=$1`, [
      task.id,
    ]);
    await engine.process(w.id, task.id);
    await paused(task, 'limit.steps');
  });
  await t.test('oversized read and proposal batches name the tool limit', async () => {
    for (const decision of [
      {
        kind: 'tools',
        text: 'Read twice.',
        calls: [
          { activity: 'First read', call: { tool: 'tables.list' } },
          { activity: 'Second read', call: { tool: 'tables.list' } },
        ],
      },
      {
        kind: 'propose',
        text: 'Write twice.',
        calls: Array.from({ length: 2 }, () => ({
          tool: 'rows.create',
          tableId: randomUUID(),
          expectedAppliedRevision: 'a'.repeat(40),
          values: {},
        })),
      },
    ]) {
      const task = await start({ toolCalls: 1 });
      await createTaskRuntime(runtime, { ...model, infer: async () => success(decision) }).process(w.id, task.id);
      await paused(task, 'limit.toolCalls');
    }
  });
  await t.test('oversized retained context pauses before model dispatch', async () => {
    const task = await start();
    for (let sequence = 1; sequence <= 5; sequence++)
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) VALUES ($1,$2,0,'owner',$3,'[]')`,
        [task.id, sequence, 'x'.repeat(8000)],
      );
    await createTaskRuntime(runtime, {
      ...model,
      infer: async () => {
        assert.fail('oversized context must not dispatch');
      },
    }).process(w.id, task.id);
    await paused(task, 'context');
  });
  await t.test('active time exhausted during inference records the time reason', async () => {
    const task = await start();
    const engine = createTaskRuntime(runtime, {
      ...model,
      infer: async () => {
        await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET active_milliseconds=120000 WHERE id=$1`, [
          task.id,
        ]);
        return success({ kind: 'answer', text: 'Too late.' });
      },
    });
    await engine.process(w.id, task.id);
    await paused(task, 'limit.activeTime');
  });
});
