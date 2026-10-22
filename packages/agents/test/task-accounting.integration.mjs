import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableWithRows, tableDefinition, textField, text } from '../../tables/test/fixture.mjs';
import { createAgentRecordTools } from '../src/record-tools.ts';
import { createAttachments } from '../../conversations/src/attachments.ts';
import { createConversations } from '../../conversations/src/index.ts';
import { fixture, markWorkspaceReady } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createTaskApprovals, createTaskApprovalDecision } from '../src/task-approvals.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { savedTaskAgent, seedExecution } from './task-fixture.mjs';
import { latestGeneration, settleAttempt } from '../src/continuity.ts';
import { registerExtension } from '@tulipfarm/extensions';
import { hostedCreditPricingExtension } from '../../workspace-storage/test/hosted-credit-pricing.mjs';

// Budget and balance assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

test('task accounting preserves work, authority and crash reservations', { timeout: 120000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations()),
    table = name => `"${w.names.schema}"."${name}"`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const user = randomUUID(),
    member = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['rows.get', 'rows.update']);
  const tasks = createAgentTasks(runtime),
    approvals = createTaskApprovals(runtime),
    executor = createAgentExecutor({ runtime });
  const name = textField(),
    fieldId = name.id,
    recordId = randomUUID(),
    revision = 'a'.repeat(40);
  const { tableId, generation: rowsGeneration } = await createTableWithRows({
    db,
    workspace: w,
    runtime,
    revision,
    definition: tableDefinition({ owningTeamId: agent.teamId, label: 'Accounting contacts', fields: [name] }),
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
  await seedExecution(db, w, agent.agentId, [agent.teamId], scope);
  const records = createAgentRecordTools(runtime);
  await records.createRecord(w.id, user, tableId, revision, { [fieldId]: text(' alice ') }, recordId);
  const get = { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId },
    update = {
      tool: 'rows.update',
      tableId,
      expectedAppliedRevision: revision,
      recordId,
      values: { [fieldId]: text('Alice') },
    };
  const tokened = async call => ({
    ...call,
    expectedToken: (await records.getRecord(w.id, user, tableId, revision, call.recordId)).token,
  });
  const route = {
    id: 'accounting-test',
    modelId: 'claude-opus-5-5',
    provider: 'anthropic',
    deployment: 'claude-opus-5-5',
    location: 'test',
    adapterVersion: 1,
    qualification: 'local',
    lifecycle: 'current',
    maxInputTokens: 100000,
    maxOutputTokens: 4096,
    boundedDecision: true,
  };
  const bundle = modelBundleSchema.parse({
    format: 1,
    id: 'accounting-test',
    mapping: {
      ...initialModelMapping,
      revision: 'accounting-test',
      families: initialModelMapping.families.filter(f => f.id === 'claude-opus'),
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
  let choose = async () => ({ kind: 'answer', text: 'Done.' }),
    selections = 0;
  const model = {
    activeBundle: () => ({ bundle, activationRevision: 1 }),
    trustedBundle: () => bundle,
    restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
    allowed: () => true,
    actualModelIds: () => [route.modelId],
    legacyFamily: () => 'claude-opus',
    budgetPicoUsd: () => '10000000000000',
    health: createModelRouteHealth(db.platform, () => 'accounting-test'),
    infer: async (_resolution, input) => {
      selections++;
      return success(await choose(JSON.parse(input.prompt)));
    },
  };
  const start = (extra = {}) =>
    tasks.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope,
      text: 'Account for this task.',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 4000 },
      ...extra,
    });
  const state = id => tasks.read(w.id, user, id);
  const entries = async id =>
    (
      await db.platform.query(`SELECT * FROM ${table('tf_agent_task_activity')} WHERE task_id=$1 ORDER BY started_at`, [
        id,
      ])
    ).rows;
  const spawn = input =>
    fork(new URL('./task-accounting-process.mjs', import.meta.url), [], {
      env: {
        ...process.env,
        TASK_ACCOUNTING_INPUT: JSON.stringify({ workspaceId: w.id, connectionString: db.login(w), ...input }),
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
  const kill = async child => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  };
  const waitFor = async predicate => {
    for (let n = 0; n < 200; n++) {
      if (await predicate()) return;
      await delay(25);
    }
    assert.fail('boundary not reached');
  };
  const engine = createTaskRuntime(runtime, model);
  const heldReservation = '23000000000000';

  await t.test('failed admitted reads consume the limit once across replay', async () => {
    choose = async () => ({
      kind: 'tool',
      text: 'Read stale revision.',
      call: { ...get, expectedAppliedRevision: 'b'.repeat(40) },
    });
    const task = await start({ limits: { toolCalls: 1, credits: 100, activeMilliseconds: 60000 } });
    for (let n = 0; n < 4; n++) await engine.process(w.id, task.id);
    const calls = (
      await db.platform.query(
        `SELECT c.* FROM ${table('tf_agent_tool_calls')} c JOIN ${table('tf_agent_task_runs')} r ON r.run_id=c.run_id WHERE r.task_id=$1`,
        [task.id],
      )
    ).rows;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 'failed');
    assert.equal((await state(task.id)).toolCalls, 1);
    await executor.execute({ workspaceId: w.id, runId: calls[0].run_id, callId: calls[0].id });
    assert.equal((await state(task.id)).toolCalls, 1);
    assert.equal((await entries(task.id)).length, 1);
  });
  await t.test('model durations survive backward and forward wall clock jumps', async () => {
    for (const jump of [-60000, 60000]) {
      const task = await start({ limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
      const wall = Date.now;
      try {
        await createTaskRuntime(runtime, {
          ...model,
          infer: async () => {
            await delay(180);
            Date.now = () => wall() + jump;
            return success({ kind: 'answer', text: 'Monotonic model duration.' });
          },
        }).process(w.id, task.id);
      } finally {
        Date.now = wall;
      }
      const actual = await state(task.id);
      assert.equal(actual.status, 'completed');
      assert.ok(Number(actual.activeMilliseconds) >= 180);
      assert.ok(Number(actual.activeMilliseconds) < 10000);
    }
  });
  await t.test('known usage survives settlement rollback without publishing the lost decision', async () => {
    const task = await start({ limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
    let failed = false;
    const failingRuntime = {
      transaction: (workspaceId, range, operation) =>
        runtime.transaction(workspaceId, range, async tx => {
          const result = await operation(tx);
          if (
            !failed &&
            (
              await tx.client.query(
                `SELECT 1 FROM ${table('tf_credit_usage')} WHERE flow_id=$1 AND charged IS NOT NULL`,
                [task.id],
              )
            ).rowCount
          ) {
            failed = true;
            throw new Error('settlement commit lost');
          }
          return result;
        }),
    };
    await assert.rejects(
      createTaskRuntime(failingRuntime, {
        ...model,
        infer: async () => {
          await delay(180);
          return success({ kind: 'answer', text: 'Never publish this rolled back decision.' });
        },
      }).process(w.id, task.id),
      /settlement commit lost/,
    );
    const attempt = (
      await db.platform.query(
        `SELECT a.* FROM ${table('tf_model_attempts')} a JOIN ${table('tf_agent_task_runs')} r ON r.run_id=a.run_id WHERE r.task_id=$1`,
        [task.id],
      )
    ).rows[0];
    await db.platform.query(
      `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [attempt.id],
    );
    choose = async () => ({ kind: 'answer', text: 'Replacement decision.' });
    await delay(400);
    await Promise.all([engine.process(w.id, task.id), engine.process(w.id, task.id)]);
    const original = (
      await db.platform.query(`SELECT charged::text FROM ${table('tf_credit_usage')} WHERE id=$1`, [attempt.id])
    ).rows[0];
    assert.equal(original.charged, '1000000000000');
    assert.ok(Number((await state(task.id)).activeMilliseconds) >= 180);
    assert.equal(
      (await tasks.history(w.id, user, task.id)).messages.some(
        message => message.text === 'Never publish this rolled back decision.',
      ),
      false,
    );
  });
  await t.test('API discovery settles paused late usage after rollback without business work', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
    const Fastify = require('fastify'),
      { Pool } = require('pg');
    const { registerTableDispatch } = await import('../../../apps/api/dist/table-dispatch.js');
    const task = await start();
    const response = Promise.withResolvers();
    let rollback = false,
      providerCalls = 0;
    const failing = {
      transaction: (workspaceId, range, operation) =>
        runtime.transaction(workspaceId, range, async tx => {
          const result = await operation(tx);
          if (
            !rollback &&
            (
              await tx.client.query(
                `SELECT 1 FROM ${table('tf_credit_usage')} WHERE flow_id=$1 AND charged IS NOT NULL`,
                [task.id],
              )
            ).rowCount
          ) {
            rollback = true;
            throw new Error('accounting settlement rollback');
          }
          return result;
        }),
    };
    const recovery = createTaskRuntime(runtime, {
      ...model,
      infer: async () => {
        providerCalls++;
        throw new Error('Unexpected business inference');
      },
    });
    await createTaskRuntime(failing, {
      ...model,
      infer: async () => {
        providerCalls++;
        return response.promise;
      },
    }).process(w.id, task.id);
    await recovery.process(w.id, task.id);
    assert.equal((await state(task.id)).status, 'paused');
    response.resolve(success({ kind: 'answer', text: 'Lost late decision.' }));
    await waitFor(() => rollback);
    await delay(50);
    assert.deepEqual((await state(task.id)).cost, { chargedCreditUnits: '0', heldCreditUnits: heldReservation });
    await markWorkspaceReady(db.platform, w.id);
    const pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
    const app = Fastify({ logger: false });
    let dispatches = 0;
    registerTableDispatch(app, {
      pool,
      runtime,
      temporal: {
        connection: { withDeadline: (_deadline, action) => action() },
        client: {
          workflow: {
            start: async (name, options) => {
              if (name === 'agentTaskStep' && options.args[1] === task.id) {
                dispatches++;
                await recovery.process(...options.args);
              }
            },
          },
        },
      },
    });
    try {
      await app.ready();
      await delay(4500);
    } finally {
      await app.close();
      await pool.end();
    }
    const settled = await state(task.id);
    assert.deepEqual(settled.cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '0' });
    assert.equal(settled.status, 'paused');
    assert.equal(settled.toolCalls, 0);
    assert.equal(providerCalls, 1);
    assert.equal(dispatches, 1);
    assert.equal(
      (await tasks.history(w.id, user, task.id)).messages.some(message => message.text === 'Lost late decision.'),
      false,
    );
    await Promise.all([recovery.process(w.id, task.id), recovery.process(w.id, task.id)]);
    assert.deepEqual((await state(task.id)).cost, settled.cost);
    assert.equal((await state(task.id)).activeMilliseconds, settled.activeMilliseconds);
  });
  await t.test('accounting progress respects leases across every business status and revoked owners', async () => {
    const { createTaskProgress } = await import('../src/task-progress.ts');
    const progress = createTaskProgress(runtime);
    for (const status of ['paused', 'completed', 'failed', 'waiting-clarification', 'waiting-approval', 'pending']) {
      const task = await start({ limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
      let rollback = false,
        providers = 0;
      const failing = {
        transaction: (workspaceId, range, operation) =>
          runtime.transaction(workspaceId, range, async tx => {
            const result = await operation(tx);
            if (
              !rollback &&
              (
                await tx.client.query(
                  `SELECT 1 FROM ${table('tf_credit_usage')} WHERE flow_id=$1 AND charged IS NOT NULL`,
                  [task.id],
                )
              ).rowCount
            ) {
              rollback = true;
              throw new Error('matrix rollback');
            }
            return result;
          }),
      };
      const recovering = createTaskRuntime(runtime, {
        ...model,
        infer: async () => {
          providers++;
          return success({ kind: 'answer', text: 'Forbidden retry.' });
        },
      });
      await assert.rejects(
        createTaskRuntime(failing, {
          ...model,
          infer: async () => {
            providers++;
            return success({ kind: 'answer', text: 'Lost matrix decision.' });
          },
        }).process(w.id, task.id),
        /matrix rollback/,
      );
      await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status=$2 WHERE id=$1`, [task.id, status]);
      const attempt = (
        await db.platform.query(`SELECT attempt_id FROM ${table('tf_agent_task_model_accounting')} WHERE task_id=$1`, [
          task.id,
        ])
      ).rows[0].attempt_id;
      await db.platform.query(
        `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1`,
        [attempt],
      );
      assert.notEqual(
        (await progress(w.id, task.id)).kind,
        'accounting',
        'a live observation must not schedule maintenance',
      );
      await recovering.process(w.id, task.id);
      assert.equal(
        (
          await db.platform.query(
            `SELECT pending FROM ${table('tf_agent_task_model_accounting')} WHERE attempt_id=$1`,
            [attempt],
          )
        ).rows[0].pending,
        true,
      );
      await delay(350);
      assert.deepEqual(await progress(w.id, task.id), { kind: 'accounting' });
      assert.ok((await engine.pending(w.id)).includes(task.id));
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        member,
      ]);
      try {
        await assert.rejects(tasks.history(w.id, user, task.id));
        await recovering.process(w.id, task.id);
        const retained = (
          await db.platform.query(`SELECT status,tool_calls FROM ${table('tf_agent_tasks')} WHERE id=$1`, [task.id])
        ).rows[0];
        assert.deepEqual(retained, { status, tool_calls: 0 });
        assert.equal(providers, 1);
        assert.equal(
          (await db.platform.query(`SELECT charged::text FROM ${table('tf_credit_usage')} WHERE id=$1`, [attempt]))
            .rows[0].charged,
          '1000000000000',
        );
        assert.notEqual((await progress(w.id, task.id)).kind, 'accounting');
        await recovering.process(w.id, task.id);
        assert.equal(providers, 1);
        assert.equal(
          (
            await db.platform.query(
              `SELECT pending FROM ${table('tf_agent_task_model_accounting')} WHERE attempt_id=$1`,
              [attempt],
            )
          ).rows[0].pending,
          false,
        );
      } finally {
        await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [member]);
      }
      assert.equal(
        (await tasks.history(w.id, user, task.id)).messages.some(message =>
          ['Lost matrix decision.', 'Forbidden retry.'].includes(message.text),
        ),
        false,
      );
    }
  });
  await t.test('revoked admin invocation fences business work while pending known usage settles once', async () => {
    const { createTaskProgress } = await import('../src/task-progress.ts');
    const progress = createTaskProgress(runtime);
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='admin' WHERE id=$1`, [member]);
    try {
      const task = await start({ limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
      assert.equal((await tasks.history(w.id, user, task.id)).messages[0].text, 'Account for this task.');
      let rollback = false,
        providerCalls = 0;
      const failing = {
        transaction: (workspaceId, range, operation) =>
          runtime.transaction(workspaceId, range, async tx => {
            const result = await operation(tx);
            if (
              !rollback &&
              (
                await tx.client.query(
                  `SELECT 1 FROM ${table('tf_credit_usage')} WHERE flow_id=$1 AND charged IS NOT NULL`,
                  [task.id],
                )
              ).rowCount
            ) {
              rollback = true;
              throw new Error('revoked invocation settlement rollback');
            }
            return result;
          }),
      };
      const counted = {
        ...model,
        infer: async () => {
          providerCalls++;
          return success({ kind: 'propose', text: 'Never publish this proposal.', calls: [await tokened(update)] });
        },
      };
      await assert.rejects(
        createTaskRuntime(failing, counted).process(w.id, task.id),
        /revoked invocation settlement rollback/,
      );
      const observation = (
        await db.platform.query(
          `SELECT attempt_id,pending FROM ${table('tf_agent_task_model_accounting')} WHERE task_id=$1`,
          [task.id],
        )
      ).rows[0];
      assert.equal(observation.pending, true);
      assert.deepEqual((await state(task.id)).cost, { chargedCreditUnits: '0', heldCreditUnits: heldReservation });
      await db.platform.query(`DELETE FROM ${table('tf_agent_grants')} WHERE agent_id=$1 AND permission='invoke'`, [
        agent.agentId,
      ]);
      await assert.rejects(tasks.history(w.id, user, task.id), AccessDenied);
      await assert.rejects(start(), AccessDenied);
      await db.platform.query(
        `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [observation.attempt_id],
      );
      assert.deepEqual(await progress(w.id, task.id), { kind: 'accounting' });
      assert.ok((await engine.pending(w.id)).includes(task.id));
      const recovery = createTaskRuntime(runtime, counted);
      await recovery.process(w.id, task.id);
      const settled = await state(task.id);
      assert.equal(settled.status, 'pending');
      assert.deepEqual(settled.cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '0' });
      assert.equal(
        (
          await db.platform.query(
            `SELECT pending FROM ${table('tf_agent_task_model_accounting')} WHERE attempt_id=$1`,
            [observation.attempt_id],
          )
        ).rows[0].pending,
        false,
      );
      await Promise.all([recovery.process(w.id, task.id), recovery.process(w.id, task.id)]);
      const fenced = await state(task.id);
      assert.equal(fenced.status, 'failed');
      assert.equal(fenced.toolCalls, 0);
      assert.deepEqual(fenced.cost, settled.cost);
      assert.equal(fenced.activeMilliseconds, settled.activeMilliseconds);
      assert.equal(providerCalls, 1);
      assert.deepEqual((await approvals.list(w.id, user, task.id)).proposals, []);
      assert.equal((await records.getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value, ' alice ');
      await assert.rejects(tasks.history(w.id, user, task.id), AccessDenied);
    } finally {
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke') ON CONFLICT DO NOTHING`,
        [agent.agentId, agent.teamId],
      );
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='member' WHERE id=$1`, [member]);
    }
  });
  await t.test('unknown and unobserved holds do not schedule endless accounting', async () => {
    const { createTaskProgress } = await import('../src/task-progress.ts');
    const { observeTaskModel } = await import('../src/task-model-accounting.ts');
    const progress = createTaskProgress(runtime);
    const task = await start();
    await createTaskRuntime(runtime, {
      ...model,
      health: createModelRouteHealth(db.platform, () => 'unknown-accounting-only'),
      infer: async () => new Promise(() => {}),
    }).process(w.id, task.id);
    await engine.process(w.id, task.id);
    assert.equal((await state(task.id)).status, 'paused');
    const accounting = (
      await db.platform.query(`SELECT attempt_id FROM ${table('tf_agent_task_model_accounting')} WHERE task_id=$1`, [
        task.id,
      ])
    ).rows[0];
    await runtime.transaction(w.id, commonCompatibility, tx =>
      observeTaskModel(
        tx,
        accounting.attempt_id,
        { actualModel: null, requestId: null, usage: { kind: 'unknown' } },
        5000,
      ),
    );
    assert.deepEqual(await progress(w.id, task.id), { kind: 'accounting' });
    await engine.process(w.id, task.id);
    assert.deepEqual(await progress(w.id, task.id), { kind: 'waiting' });
    assert.equal((await engine.pending(w.id)).includes(task.id), false);
    assert.deepEqual((await state(task.id)).cost, { chargedCreditUnits: '0', heldCreditUnits: heldReservation });
    await db.platform.query(
      `UPDATE ${table('tf_agent_task_model_accounting')} SET observation=NULL,observed_milliseconds=NULL WHERE attempt_id=$1`,
      [accounting.attempt_id],
    );
    assert.deepEqual(await progress(w.id, task.id), { kind: 'waiting' });
    assert.equal((await engine.pending(w.id)).includes(task.id), false);
  });
  await t.test('slow approved effect commits once, pauses, and excludes human wait', async () => {
    choose = async () => ({ kind: 'propose', text: 'Exact update.', calls: [await tokened(update)] });
    const task = await start();
    await engine.process(w.id, task.id);
    const proposal = await approvals.read(
      w.id,
      user,
      task.id,
      (await approvals.list(w.id, user, task.id)).proposals[0].id,
    );
    const before = (await state(task.id)).activeMilliseconds;
    await delay(100);
    await engine.process(w.id, task.id);
    assert.equal((await state(task.id)).activeMilliseconds, before);
    const decide = createTaskApprovalDecision({
      runtime,
      resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
    });
    await assert.rejects(
      decide(w.id, w.userId, task.id, proposal.id, { digest: proposal.digest, decision: 'approve' }),
    );
    await decide(w.id, user, task.id, proposal.id, { digest: proposal.digest, decision: 'approve' });
    const callId = proposal.actions[0].id,
      ids = { workspaceId: w.id, runId: proposal.runId, callId };
    await db.databaseAdmin.query('BEGIN');
    await db.databaseAdmin.query(`LOCK TABLE ${table(rowsGeneration.physical_table)} IN ACCESS EXCLUSIVE MODE`);
    const running = executor.execute(ids);
    await delay(4200);
    await db.databaseAdmin.query('COMMIT');
    assert.equal(await running, 'completed');
    assert.equal((await records.getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value, 'Alice');
    assert.equal((await state(task.id)).status, 'paused');
    assert.ok(Number((await state(task.id)).activeMilliseconds) >= 4000);
    const charged = (await state(task.id)).activeMilliseconds;
    await executor.execute(ids);
    await engine.process(w.id, task.id);
    assert.equal((await state(task.id)).activeMilliseconds, charged);
    assert.equal((await approvals.status(w.id, user, task.id, proposal.id)).actions[0].status, 'completed');
    assert.equal((await entries(task.id)).length, 1);
  });
  await t.test('approved effect rollback keeps admission but cannot retain a false receipt', async () => {
    choose = async () => ({
      kind: 'propose',
      text: 'Rollback proof.',
      calls: [await tokened({ ...update, values: { [fieldId]: text('Rollback value') } })],
    });
    const task = await start({ limits: { toolCalls: 1, credits: 100, activeMilliseconds: 60000 } });
    await engine.process(w.id, task.id);
    const proposal = await approvals.read(
      w.id,
      user,
      task.id,
      (await approvals.list(w.id, user, task.id)).proposals[0].id,
    );
    await createTaskApprovalDecision({
      runtime,
      resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
    })(w.id, user, task.id, proposal.id, { digest: proposal.digest, decision: 'approve' });
    const callId = proposal.actions[0].id,
      ids = { workspaceId: w.id, runId: proposal.runId, callId };
    let failed = false;
    const failingRuntime = {
      transaction: (workspaceId, range, operation) =>
        runtime.transaction(workspaceId, range, async tx => {
          const result = await operation(tx);
          if (
            !failed &&
            (
              await tx.client.query(
                `SELECT 1 FROM ${table('tf_agent_task_action_receipts')} WHERE call_id=$1 AND status='completed'`,
                [callId],
              )
            ).rowCount
          ) {
            failed = true;
            throw new Error('effect commit lost');
          }
          return result;
        }),
    };
    await assert.rejects(createAgentExecutor({ runtime: failingRuntime }).execute(ids), /unavailable/);
    assert.equal((await state(task.id)).toolCalls, 1);
    assert.equal((await records.getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value, 'Alice');
    assert.equal((await approvals.status(w.id, user, task.id, proposal.id)).actions[0].status, 'unattempted');
    const outcomes = await Promise.all([executor.execute(ids), executor.execute(ids)]);
    assert.ok(outcomes.includes('completed'));
    assert.ok(outcomes.every(outcome => outcome === 'completed' || outcome === 'waiting'));
    assert.equal((await state(task.id)).toolCalls, 1);
    assert.equal(
      (await records.getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value,
      'Rollback value',
    );
    assert.equal((await approvals.status(w.id, user, task.id, proposal.id)).actions[0].status, 'completed');
    const charged = (await state(task.id)).activeMilliseconds;
    assert.equal(await executor.execute(ids), 'completed');
    assert.equal((await state(task.id)).activeMilliseconds, charged);
  });
  await t.test('SIGKILL after durable usage observation recovers original credits and duration once', async () => {
    const task = await start({ limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
    const child = spawn({ taskId: task.id, registry: db.connectionString, route, settlementKill: true });
    t.after(() => kill(child));
    const [message] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Child exited before settlement boundary');
      }),
    ]);
    assert.deepEqual(message, { boundary: 'settlement-uncommitted' });
    await kill(child);
    const observation = (
      await db.platform.query(`SELECT * FROM ${table('tf_agent_task_model_accounting')} WHERE task_id=$1`, [task.id])
    ).rows[0];
    assert.equal(observation.pending, true);
    assert.ok(Number(observation.observed_milliseconds) >= 180);
    await db.platform.query(
      `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [observation.attempt_id],
    );
    await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='paused' WHERE id=$1`, [task.id]);
    assert.ok((await engine.pending(w.id)).includes(task.id));
    await Promise.all([engine.process(w.id, task.id), engine.process(w.id, task.id)]);
    assert.deepEqual((await state(task.id)).cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '0' });
    assert.equal((await state(task.id)).activeMilliseconds, observation.observed_milliseconds);
    assert.equal((await state(task.id)).status, 'paused');
    assert.equal(
      (await tasks.history(w.id, user, task.id)).messages.some(item => item.text === 'Lost process decision.'),
      false,
    );
    assert.equal(
      (
        await db.platform.query(
          `SELECT g.spent_pico_usd FROM ${table('tf_model_generations')} g JOIN ${table('tf_agent_task_runs')} r USING (run_id) WHERE r.task_id=$1`,
          [task.id],
        )
      ).rows[0].spent_pico_usd,
      '80000000',
    );
    assert.equal((await engine.pending(w.id)).includes(task.id), false);
    await engine.process(w.id, task.id);
    assert.equal((await state(task.id)).activeMilliseconds, observation.observed_milliseconds);
  });
  await t.test('competing discovery cannot abandon a live observed model response', async () => {
    const task = await start({ limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let held = false;
    const delayedRuntime = {
      transaction: async (workspaceId, range, operation) => {
        const result = await runtime.transaction(workspaceId, range, operation);
        if (
          !held &&
          (
            await db.platform.query(
              `SELECT 1 FROM ${table('tf_agent_task_model_accounting')} WHERE task_id=$1 AND pending`,
              [task.id],
            )
          ).rowCount
        ) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    };
    const running = createTaskRuntime(delayedRuntime, {
      ...model,
      infer: async () => success({ kind: 'answer', text: 'Live observation wins.' }),
    }).process(w.id, task.id);
    await entered.promise;
    try {
      await engine.process(w.id, task.id);
    } finally {
      release.resolve();
    }
    await running;
    assert.equal((await state(task.id)).status, 'completed');
    assert.equal((await tasks.history(w.id, user, task.id)).messages.at(-1).text, 'Live observation wins.');
    assert.deepEqual((await state(task.id)).cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '0' });
  });
  await t.test('killed read retains reservation and dual recovery cannot evade the limit', async () => {
    choose = async () => ({ kind: 'tool', text: 'Read.', call: get });
    const task = await start();
    await engine.process(w.id, task.id);
    const call = (
      await db.platform.query(
        `SELECT run_id,id FROM ${table('tf_agent_tool_calls')} WHERE run_id IN (SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1)`,
        [task.id],
      )
    ).rows[0];
    await db.databaseAdmin.query('BEGIN');
    await db.databaseAdmin.query(`LOCK TABLE ${table(rowsGeneration.physical_table)} IN ACCESS EXCLUSIVE MODE`);
    const child = spawn({ runId: call.run_id, callId: call.id });
    t.after(() => kill(child));
    await waitFor(async () => (await entries(task.id)).length === 1);
    await delay(100);
    await kill(child);
    await db.databaseAdmin.query('COMMIT');
    assert.equal((await state(task.id)).activeMilliseconds, '4000');
    await delay(4100);
    const before = selections;
    await Promise.all([engine.process(w.id, task.id), engine.process(w.id, task.id)]);
    assert.equal((await state(task.id)).status, 'paused');
    assert.equal(selections, before);
    assert.equal((await entries(task.id))[0].status, 'abandoned');
    const history = await tasks.history(w.id, user, task.id);
    await tasks.continueTask(w.id, user, task.id, {
      requestId: randomUUID(),
      expectedGeneration: 0,
      expectedSequence: history.messages.at(-1).sequence,
      text: 'Continue.',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 10000 },
    });
    await Promise.all([engine.process(w.id, task.id), engine.process(w.id, task.id)]);
    assert.equal(
      (await db.platform.query(`SELECT status FROM ${table('tf_agent_tool_calls')} WHERE id=$1`, [call.id])).rows[0]
        .status,
      'completed',
    );
    assert.equal((await state(task.id)).toolCalls, 1);
    assert.ok(Number((await state(task.id)).activeMilliseconds) >= 4000);
  });
  const objects = new Map(),
    attachments = createAttachments(runtime, {
      putIfAbsent: async (key, bytes) => objects.set(key, bytes),
      read: async key => objects.get(key),
      remove: async key => objects.delete(key),
    });
  const conversationId = randomUUID(),
    attachmentId = randomUUID(),
    bytes = Buffer.from('Verified file content.');
  await createConversations(runtime).create(w.id, user, { chatId: conversationId, commandId: randomUUID() });
  await attachments.reserve(w.id, user, conversationId, attachmentId, {
    filename: 'accounting.txt',
    mediaType: 'text/plain',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  await attachments.upload(w.id, user, conversationId, attachmentId, bytes);
  await createConversations(runtime).send(w.id, user, conversationId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'attachment', attachmentId }],
  });
  const sources = [{ kind: 'attachment', conversationId, attachmentId }];
  await t.test('backoff polling performs no file work and due retry materializes once', async () => {
    const task = await start({ sources, limits: { toolCalls: 10, credits: 100, activeMilliseconds: 12000 } });
    let reads = 0,
      calls = 0;
    const fileEngine = createTaskRuntime(
      runtime,
      {
        ...model,
        infer: async (_resolution, input) => {
          calls++;
          assert.equal(JSON.parse(input.prompt).files[0].text, 'Verified file content.');
          return calls === 1
            ? {
                kind: 'failure',
                reason: 'rate-limit',
                status: 429,
                retryAfterMs: 30000,
                actualModel: route.modelId,
                requestId: randomUUID(),
                usage: { kind: 'unknown' },
              }
            : success({ kind: 'answer', text: 'Retry read completed.' });
        },
      },
      async input => {
        reads++;
        await delay(180);
        const file = await attachments.download(
          input.workspaceId,
          input.userId,
          input.conversationId,
          input.attachmentId,
        );
        return { filename: file.filename, text: Buffer.from(file.bytes).toString() };
      },
    );
    await fileEngine.process(w.id, task.id);
    const before = (await state(task.id)).activeMilliseconds;
    for (let n = 0; n < 4; n++) await fileEngine.process(w.id, task.id);
    assert.equal(reads, 1);
    assert.equal(calls, 1);
    assert.equal((await entries(task.id)).length, 1);
    assert.equal((await state(task.id)).activeMilliseconds, before);
    assert.equal((await state(task.id)).status, 'pending');
    await db.platform.query(
      `UPDATE ${table('tf_model_generations')} SET next_at=clock_timestamp()-interval '1 second' WHERE run_id IN (SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1)`,
      [task.id],
    );
    await delay(1100);
    await fileEngine.process(w.id, task.id);
    assert.equal(reads, 2);
    assert.equal(calls, 2);
    assert.equal((await entries(task.id)).length, 2);
    assert.equal((await state(task.id)).status, 'completed');
    assert.ok(Number((await state(task.id)).activeMilliseconds) >= Number(before) + 180);
  });
  await t.test('file IO releases task locks, rechecks authority and retries transient errors', async () => {
    const task = await start({ sources, limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
    const fileEngine = createTaskRuntime(
      runtime,
      {
        ...model,
        infer: async (_resolution, input) => {
          assert.equal(JSON.parse(input.prompt).files[0].text, 'Verified file content.');
          return success({ kind: 'answer', text: 'Read outside the transaction.' });
        },
      },
      async input => {
        const competing = approvals.list(w.id, user, task.id);
        await delay(100);
        const file = await attachments.download(
          input.workspaceId,
          input.userId,
          input.conversationId,
          input.attachmentId,
        );
        await competing;
        return { filename: file.filename, text: Buffer.from(file.bytes).toString() };
      },
    );
    await fileEngine.process(w.id, task.id);
    assert.equal((await state(task.id)).status, 'completed');
    const transient = await start({ sources, limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
    await assert.rejects(
      createTaskRuntime(runtime, model, async () => {
        throw new Error('temporary transport');
      }).process(w.id, transient.id),
      /temporary transport/,
    );
    assert.equal((await state(transient.id)).status, 'pending');
    assert.equal((await entries(transient.id))[0].status, 'settled');
    await fileEngine.process(w.id, transient.id);
    assert.equal((await state(transient.id)).status, 'completed');
    const revoked = await start({ sources }),
      entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let inferred = false;
    const recheck = createTaskRuntime(
      runtime,
      {
        ...model,
        infer: async () => {
          inferred = true;
          return success({ kind: 'answer', text: 'Forbidden.' });
        },
      },
      async () => {
        entered.resolve();
        await release.promise;
        return { filename: 'accounting.txt', text: 'Verified file content.' };
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
    assert.equal((await state(revoked.id)).status, 'failed');
    assert.equal((await entries(revoked.id))[0].status, 'settled');
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=NULL WHERE id=$1`, [
      agent.activationId,
    ]);
  });
  await t.test('killed file materialization retains its committed hold without charging idle recovery', async () => {
    const task = await start({ sources }),
      child = spawn({ taskId: task.id, registry: db.connectionString, route });
    t.after(() => kill(child));
    const [message] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Child exited before active file boundary');
      }),
    ]);
    assert.deepEqual(message, { boundary: 'file-active' });
    await kill(child);
    assert.equal((await state(task.id)).activeMilliseconds, '4000');
    await delay(4100);
    await Promise.all([engine.process(w.id, task.id), engine.process(w.id, task.id)]);
    assert.equal((await state(task.id)).status, 'paused');
    assert.equal((await state(task.id)).activeMilliseconds, '4000');
    assert.equal((await entries(task.id))[0].status, 'abandoned');
  });
  await t.test('slow authorized file consumes time and prevents inference', async () => {
    const task = await start({ sources }),
      before = selections;
    let reads = 0;
    await createTaskRuntime(runtime, model, async input => {
      reads++;
      await delay(4200);
      const file = await attachments.download(
        input.workspaceId,
        input.userId,
        input.conversationId,
        input.attachmentId,
      );
      assert.equal(Buffer.from(file.bytes).toString(), 'Verified file content.');
      return { filename: file.filename, text: Buffer.from(file.bytes).toString() };
    }).process(w.id, task.id);
    assert.equal(reads, 1);
    assert.equal(selections, before);
    assert.equal((await state(task.id)).status, 'paused');
    assert.ok(Number((await state(task.id)).activeMilliseconds) >= 4000);
    const charged = (await state(task.id)).activeMilliseconds;
    await engine.process(w.id, task.id);
    assert.equal((await state(task.id)).activeMilliseconds, charged);
  });
  await t.test('late settlement corrects both ledgers once and never creates a proposal', async () => {
    await delay(1100);
    const release = Promise.withResolvers(),
      entered = Promise.withResolvers();
    let returned;
    const lateModel = {
      ...model,
      infer: async () => {
        entered.resolve();
        await release.promise;
        returned = success({ kind: 'propose', text: 'Never publish.', calls: [await tokened(update)] });
        return returned;
      },
    };
    const task = await start(),
      running = createTaskRuntime(runtime, lateModel).process(w.id, task.id);
    await entered.promise;
    await running;
    assert.equal((await state(task.id)).cost.heldCreditUnits, heldReservation);
    release.resolve();
    await waitFor(async () => (await state(task.id)).cost.heldCreditUnits === '0');
    const attempt = (
      await db.platform.query(
        `SELECT a.* FROM ${table('tf_model_attempts')} a JOIN ${table('tf_agent_task_runs')} r ON r.run_id=a.run_id WHERE r.task_id=$1`,
        [task.id],
      )
    ).rows[0];
    for (let n = 0; n < 2; n++)
      await runtime.transaction(w.id, commonCompatibility, async tx => {
        const generation = await latestGeneration(tx, attempt.run_id);
        await settleAttempt(tx, lateModel, generation, attempt, returned);
      });
    assert.deepEqual((await state(task.id)).cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '0' });
    assert.equal(
      (
        await db.platform.query(`SELECT spent_pico_usd FROM ${table('tf_model_generations')} WHERE run_id=$1`, [
          attempt.run_id,
        ])
      ).rows[0].spent_pico_usd,
      '80000000',
    );
    assert.equal((await approvals.list(w.id, user, task.id)).proposals.length, 0);
  });
  await t.test('expired and cancelled attempts retain usage but publish no decision', async () => {
    for (const boundary of ['expired', 'cancelled']) {
      await delay(1100);
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      const task = await start({ limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
      const running = createTaskRuntime(runtime, {
        ...model,
        infer: async () => {
          entered.resolve();
          await release.promise;
          return success({ kind: 'propose', text: 'No stale decision.', calls: [await tokened(update)] });
        },
      }).process(w.id, task.id);
      await entered.promise;
      const runId = (
        await db.platform.query(`SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1`, [task.id])
      ).rows[0].run_id;
      if (boundary === 'expired')
        await db.platform.query(
          `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1`,
          [runId],
        );
      else
        await db.platform.query(
          `UPDATE ${table('tf_model_generations')} SET status='failed',failure='cancelled' WHERE run_id=$1`,
          [runId],
        );
      release.resolve();
      await running;
      assert.deepEqual((await state(task.id)).cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '0' });
      assert.equal((await approvals.list(w.id, user, task.id)).proposals.length, 0);
      assert.equal(
        (await tasks.history(w.id, user, task.id)).messages.some(message => message.text === 'No stale decision.'),
        false,
      );
    }
  });
  await t.test('unknown usage stays held and revoked postsettlement budget denies publication', async () => {
    await delay(1100);
    const unknown = await start({ limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
    await createTaskRuntime(runtime, {
      ...model,
      infer: async () => ({
        kind: 'failure',
        reason: 'timeout',
        status: null,
        retryAfterMs: null,
        actualModel: null,
        requestId: null,
        usage: { kind: 'unknown' },
      }),
    }).process(w.id, unknown.id);
    assert.deepEqual((await state(unknown.id)).cost, { chargedCreditUnits: '0', heldCreditUnits: heldReservation });
    await delay(1100);
    let budget = '10000000000000';
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      task = await start();
    const running = createTaskRuntime(runtime, {
      ...model,
      budgetPicoUsd: () => budget,
      infer: async () => {
        entered.resolve();
        await release.promise;
        return success({ kind: 'propose', text: 'Budget revoked.', calls: [await tokened(update)] });
      },
    }).process(w.id, task.id);
    await entered.promise;
    budget = '0';
    release.resolve();
    await running;
    assert.deepEqual((await state(task.id)).cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '0' });
    assert.equal((await approvals.list(w.id, user, task.id)).proposals.length, 0);
  });
  await t.test('unapproved calls leave the allowance for an approved replacement', async () => {
    const task = await start({ limits: { toolCalls: 1, credits: 100, activeMilliseconds: 60000 } });
    const call = await tokened({ ...update, values: { [fieldId]: text('Approved replacement') } });
    const proposal = await approvals.propose(w.id, user, task.id, {
      requestId: randomUUID(),
      generation: 0,
      calls: [call],
    });
    const ids = { workspaceId: w.id, runId: proposal.runId, callId: proposal.actions[0].id };
    const before = await state(task.id);
    for (let n = 0; n < 2; n++) assert.equal(await executor.execute(ids), 'waiting');
    assert.equal((await state(task.id)).toolCalls, 0);
    assert.equal((await state(task.id)).activeMilliseconds, before.activeMilliseconds);
    assert.equal((await entries(task.id)).length, 0);
    const decide = createTaskApprovalDecision({
      runtime,
      resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
    });
    await decide(w.id, user, task.id, proposal.id, { digest: proposal.digest, decision: 'reject' });
    const replacement = await approvals.propose(w.id, user, task.id, {
      requestId: randomUUID(),
      generation: 0,
      calls: [call],
    });
    await decide(w.id, user, task.id, replacement.id, { digest: replacement.digest, decision: 'approve' });
    assert.equal(
      await executor.execute({ workspaceId: w.id, runId: replacement.runId, callId: replacement.actions[0].id }),
      'completed',
    );
    assert.equal((await state(task.id)).toolCalls, 1);
    assert.equal(
      (await records.getRecord(w.id, user, tableId, revision, recordId)).values[fieldId].value,
      'Approved replacement',
    );
  });
  await t.test('a later approved action waits without charging until its predecessor completes', async () => {
    const secondRecord = randomUUID();
    await records.createRecord(w.id, user, tableId, revision, { [fieldId]: text('Second original') }, secondRecord);
    const task = await start({ limits: { toolCalls: 2, credits: 100, activeMilliseconds: 60000 } });
    const proposal = await approvals.propose(w.id, user, task.id, {
      requestId: randomUUID(),
      generation: 0,
      calls: [
        await tokened({ ...update, values: { [fieldId]: text('First ordered') } }),
        await tokened({ ...update, recordId: secondRecord, values: { [fieldId]: text('Second ordered') } }),
      ],
    });
    await createTaskApprovalDecision({
      runtime,
      resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
    })(w.id, user, task.id, proposal.id, { digest: proposal.digest, decision: 'approve' });
    const ids = callId => ({ workspaceId: w.id, runId: proposal.runId, callId });
    const before = await state(task.id);
    assert.equal(await executor.execute(ids(proposal.actions[1].id)), 'waiting');
    assert.equal((await state(task.id)).toolCalls, 0);
    assert.equal((await state(task.id)).activeMilliseconds, before.activeMilliseconds);
    assert.equal(
      (await records.getRecord(w.id, user, tableId, revision, secondRecord)).values[fieldId].value,
      'Second original',
    );
    assert.equal(await executor.execute(ids(proposal.actions[0].id)), 'completed');
    assert.equal(await executor.execute(ids(proposal.actions[1].id)), 'completed');
    assert.equal((await state(task.id)).toolCalls, 2);
    assert.equal(
      (await records.getRecord(w.id, user, tableId, revision, secondRecord)).values[fieldId].value,
      'Second ordered',
    );
    const charged = (await state(task.id)).activeMilliseconds;
    assert.equal(await executor.execute(ids(proposal.actions[1].id)), 'completed');
    assert.equal((await state(task.id)).activeMilliseconds, charged);
  });
  await t.test(
    'not-started rollback recovery zeros both ledgers once while dispatched unknown stays held',
    async () => {
      for (const dispatch of ['not-started', 'unknown']) {
        const response = {
          kind: 'failure',
          reason: 'configuration',
          status: null,
          retryAfterMs: null,
          actualModel: null,
          requestId: null,
          usage: { kind: 'unknown' },
          ...(dispatch === 'not-started' ? { dispatch } : {}),
        };
        const task = await start({ limits: { toolCalls: 10, credits: 100, activeMilliseconds: 60000 } });
        let rollback = false;
        const failing = {
          transaction: (workspaceId, range, operation) =>
            runtime.transaction(workspaceId, range, async tx => {
              const result = await operation(tx);
              if (
                !rollback &&
                (
                  await tx.client.query(
                    `SELECT 1 FROM ${table('tf_model_attempts')} a JOIN ${table('tf_agent_task_runs')} r ON r.run_id=a.run_id WHERE r.task_id=$1 AND a.status='failed'`,
                    [task.id],
                  )
                ).rowCount
              ) {
                rollback = true;
                throw new Error('observed settlement rollback');
              }
              return result;
            }),
        };
        await assert.rejects(
          createTaskRuntime(failing, { ...model, infer: async () => response }).process(w.id, task.id),
          /observed settlement rollback/,
        );
        const attempt = (
          await db.platform.query(
            `SELECT a.* FROM ${table('tf_model_attempts')} a JOIN ${table('tf_agent_task_runs')} r ON r.run_id=a.run_id WHERE r.task_id=$1`,
            [task.id],
          )
        ).rows[0];
        await db.platform.query(
          `UPDATE ${table('tf_model_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [attempt.id],
        );
        await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='paused' WHERE id=$1`, [task.id]);
        await Promise.all([engine.process(w.id, task.id), engine.process(w.id, task.id)]);
        for (let n = 0; n < 2; n++)
          await runtime.transaction(w.id, commonCompatibility, async tx => {
            await settleAttempt(tx, model, await latestGeneration(tx, attempt.run_id), attempt, response);
          });
        assert.deepEqual((await state(task.id)).cost, {
          chargedCreditUnits: '0',
          heldCreditUnits: dispatch === 'not-started' ? '0' : heldReservation,
        });
        assert.equal(
          (
            await db.platform.query(`SELECT spent_pico_usd FROM ${table('tf_model_generations')} WHERE run_id=$1`, [
              attempt.run_id,
            ])
          ).rows[0].spent_pico_usd,
          dispatch === 'not-started' ? '0' : attempt.reserved_pico_usd,
        );
      }
    },
  );
  await t.test('dispatch transaction failure still observes eventual known provider usage', async () => {
    await delay(1100);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      task = await start();
    let dispatched = false,
      failed = false;
    const failingRuntime = {
      transaction: (workspaceId, range, operation) =>
        runtime.transaction(workspaceId, range, async tx => {
          const result = await operation(tx);
          if (dispatched && !failed) {
            failed = true;
            throw new Error('lost dispatch commit');
          }
          return result;
        }),
    };
    const running = createTaskRuntime(failingRuntime, {
      ...model,
      infer: async () => {
        dispatched = true;
        entered.resolve();
        await release.promise;
        return success({ kind: 'propose', text: 'Do not publish after rollback.', calls: [await tokened(update)] });
      },
    }).process(w.id, task.id);
    await entered.promise;
    await running;
    release.resolve();
    await waitFor(async () => (await state(task.id)).cost.heldCreditUnits === '0');
    assert.equal(failed, true);
    assert.deepEqual((await state(task.id)).cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '0' });
    assert.equal((await approvals.list(w.id, user, task.id)).proposals.length, 0);
  });
});
