import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { createSecretRequests, createSecrets, taskSecretTools } from '@tulipfarm/secrets';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createTaskProgress } from '../src/task-progress.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';

const route = {
  id: 'secret-task',
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
  id: 'secret-task',
  mapping: {
    ...initialModelMapping,
    revision: 'secret-task',
    families: initialModelMapping.families.filter(f => f.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [route],
});
const ask = {
  tool: 'secrets.request',
  purpose: 'Read the billing service invoices.',
  fields: [{ id: 'billing', label: 'Billing token', kind: 'token', placement: { kind: 'bearer' } }],
  destinations: [{ kind: 'host', host: 'billing' }],
};

test(
  'a task asks its owner for a secret, waits, and keeps a temporary value only for the run',
  { timeout: 240000 },
  async t => {
    const previous = process.env.SECRETS_ENABLED;
    process.env.SECRETS_ENABLED = 'true';
    const db = await fixture();
    let runtime;
    t.after(async () => {
      if (previous === undefined) delete process.env.SECRETS_ENABLED;
      else process.env.SECRETS_ENABLED = previous;
      await runtime?.close();
      await db.close();
    });
    await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
    await db.platform.query(
      await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8'),
    );
    const w = await db.create(await workspaceTableMigrations()),
      table = name => `"${w.names.schema}"."${name}"`;
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1,granted=$1`, ['100000000000000']);
    const member = async () => {
      const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        actor.membershipId,
        actor.userId,
      ]);
      return actor;
    };
    const owner = await member(),
      other = await member();
    const agent = await savedTaskAgent(db, w, runtime, owner.userId, owner.membershipId, [], ['rows.list']);
    await createAgentExecutor({ runtime }).configure(
      w.id,
      { kind: 'human', userId: w.userId, membershipId: w.membershipId },
      { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
    );

    const privateHosts = [{ host: 'billing', port: null, http: false }];
    const secrets = createSecrets({
      runtime,
      keyring: { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } },
      enabled: true,
      privateHosts,
    });
    const requests = createSecretRequests(secrets);
    const access = { tools: taskSecretTools(secrets, requests), privateHosts };

    const prompts = [];
    let decisions = [];
    const model = {
      activeBundle: () => ({ bundle, activationRevision: 1 }),
      trustedBundle: () => bundle,
      restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
      allowed: () => true,
      actualModelIds: () => [route.modelId],
      defaultFamily: () => 'claude-opus',
      budgetPicoUsd: () => '10000000000000',
      health: createModelRouteHealth(db.platform, () => 'secret-task'),
      infer: async (_resolution, input) => {
        prompts.push(input.prompt);
        return {
          kind: 'success',
          decision: decisions.shift() ?? { kind: 'answer', text: 'Done.' },
          actualModel: route.modelId,
          requestId: randomUUID(),
          usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        };
      },
    };
    const tasks = createAgentTasks(runtime);
    const progress = createTaskProgress(runtime);
    const engine = createTaskRuntime(
      runtime,
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      access,
    );
    const start = () =>
      tasks.start(w.id, owner.userId, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        scope: [],
        text: 'Compare the billing invoices.',
        limits: { toolCalls: 10, credits: 100, activeMilliseconds: 120000 },
      });
    const settle = async taskId => {
      for (let n = 0; n < 8 && (await tasks.read(w.id, owner.userId, taskId)).status === 'pending'; n++)
        await engine.process(w.id, taskId);
      return (await tasks.read(w.id, owner.userId, taskId)).status;
    };
    const toolCall = async (taskId, tool) =>
      (
        await db.platform.query(
          `SELECT c.id,c.status,c.result FROM ${table('tf_agent_tool_calls')} c JOIN ${table('tf_agent_task_runs')} b ON b.run_id=c.run_id
         WHERE b.task_id=$1 AND c.call->>'tool'=$2 ORDER BY b.generation DESC, c.sequence DESC LIMIT 1`,
          [taskId, tool],
        )
      ).rows[0];
    const temporarySecrets = async taskId =>
      (
        await db.platform.query(
          `SELECT status FROM ${table('tf_secrets')} WHERE lifetime='conversation' AND origin->>'taskId'=$1`,
          [taskId],
        )
      ).rows.map(row => row.status);

    await t.test('only the owner sees and answers the form; the task waits, then lists the secret', async () => {
      decisions = [
        { kind: 'tool', text: 'I need the billing token.', call: ask },
        { kind: 'tool', text: 'Checking what I hold.', call: { tool: 'secrets.list' } },
        { kind: 'answer', text: 'Compared.' },
      ];
      prompts.length = 0;
      const task = await start();
      assert.equal(await settle(task.id), 'waiting-approval');
      const asked = await toolCall(task.id, 'secrets.request');
      assert.equal(asked.status, 'waiting');
      assert.deepEqual(asked.result, { status: 'awaiting-input', secretRequestId: asked.id });
      assert.deepEqual(await progress(w.id, task.id), { kind: 'waiting' });
      await engine.process(w.id, task.id);
      assert.equal(prompts.length, 1, 'an unanswered form keeps the task waiting');

      assert.deepEqual(await requests.forTask(w.id, other, task.id), []);
      await assert.rejects(requests.view(w.id, other, asked.id), AccessDenied);
      await assert.rejects(
        requests.submit(w.id, other, asked.id, {
          requestId: randomUUID(),
          expectedRevision: 1,
          fields: [{ fieldId: 'billing', value: { value: 'stolen-token-value' }, lifetime: 'conversation' }],
        }),
        AccessDenied,
      );
      assert.deepEqual(
        await requests.origin(w.id, other, asked.id).catch(error => error instanceof AccessDenied),
        true,
      );

      const [listed] = await requests.forTask(w.id, owner, task.id);
      assert.equal(listed.id, asked.id);
      assert.equal(listed.status, 'waiting');
      assert.equal(listed.purpose, ask.purpose);
      assert.deepEqual(await requests.origin(w.id, owner, asked.id), {
        kind: 'task',
        taskId: task.id,
        runId: (
          await db.platform.query(`SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1`, [task.id])
        ).rows[0].run_id,
      });
      await requests.submit(w.id, owner, asked.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        fields: [{ fieldId: 'billing', value: { value: 'billing-token-0123' }, lifetime: 'conversation' }],
      });
      assert.deepEqual(await progress(w.id, task.id), { kind: 'runnable' });
      assert.deepEqual(await temporarySecrets(task.id), ['active']);

      await engine.process(w.id, task.id);
      assert.equal(await settle(task.id), 'completed');
      assert.equal(prompts.length, 3);
      const answered = await toolCall(task.id, 'secrets.request');
      assert.equal(answered.status, 'completed');
      assert.equal(answered.result.status, 'provided');
      assert.equal(answered.result.references[0].name, 'Billing token');
      const list = await toolCall(task.id, 'secrets.list');
      assert.equal(list.result.references.length, 1);
      assert.equal(list.result.references[0].status, 'active');
      assert.match(list.result.references[0].variableName, /^BILLING_TOKEN/);
      assert.doesNotMatch(JSON.stringify(prompts), /billing-token-0123/);
      assert.equal(
        (await requests.forTask(w.id, owner, task.id))[0].status,
        'provided',
        'the settled form stays on the task page',
      );
      assert.notDeepEqual(await temporarySecrets(task.id), ['active'], 'the run-bound value ends with the run');
    });

    await t.test('a declined or expired form wakes the task to continue without the secret', async () => {
      decisions = [{ kind: 'tool', text: 'I need the billing token.', call: ask }];
      const declined = await start();
      assert.equal(await settle(declined.id), 'waiting-approval');
      const first = await toolCall(declined.id, 'secrets.request');
      await requests.decline(w.id, owner, first.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        reason: 'Not now',
      });
      assert.deepEqual(await progress(w.id, declined.id), { kind: 'runnable' });
      await engine.process(w.id, declined.id);
      assert.equal(await settle(declined.id), 'completed');
      assert.equal((await toolCall(declined.id, 'secrets.request')).result.status, 'declined');

      decisions = [{ kind: 'tool', text: 'I need the billing token.', call: ask }];
      const expired = await start();
      assert.equal(await settle(expired.id), 'waiting-approval');
      const second = await toolCall(expired.id, 'secrets.request');
      await db.platform.query(
        `UPDATE ${table('tf_secret_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [second.id],
      );
      assert.deepEqual(await progress(w.id, expired.id), { kind: 'runnable' });
      await engine.process(w.id, expired.id);
      assert.equal(await settle(expired.id), 'completed');
      assert.equal((await toolCall(expired.id, 'secrets.request')).result.status, 'expired');
    });

    await t.test('the sweep deletes a temporary value whose run ended without cleanup', async () => {
      decisions = [{ kind: 'tool', text: 'I need the billing token.', call: ask }];
      const task = await start();
      assert.equal(await settle(task.id), 'waiting-approval');
      const asked = await toolCall(task.id, 'secrets.request');
      await requests.submit(w.id, owner, asked.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        fields: [{ fieldId: 'billing', value: { value: 'billing-token-4567' }, lifetime: 'conversation' }],
      });
      assert.deepEqual(await temporarySecrets(task.id), ['active']);
      await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='failed' WHERE id=$1`, [task.id]);
      const swept = await requests.sweep(w.id);
      assert.ok(swept.endedRuns >= 1);
      assert.notDeepEqual(await temporarySecrets(task.id), ['active']);
    });

    await t.test('without secrets a task is not offered the secret tools', async () => {
      const off = createSecrets({ runtime, keyring: { activeKeyId: 'test', keys: {} }, enabled: false });
      const offEngine = createTaskRuntime(
        runtime,
        model,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { tools: taskSecretTools(off, createSecretRequests(off)), privateHosts: [] },
      );
      decisions = [{ kind: 'tool', text: 'I need the billing token.', call: ask }];
      const task = await start();
      for (let n = 0; n < 8 && (await tasks.read(w.id, owner.userId, task.id)).status === 'pending'; n++)
        await offEngine.process(w.id, task.id);
      assert.equal((await tasks.read(w.id, owner.userId, task.id)).status, 'failed');
      assert.equal(
        await toolCall(task.id, 'secrets.request'),
        undefined,
        'the model cannot call a tool it was not offered',
      );
    });
  },
);
