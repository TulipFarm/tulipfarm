import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { decideApiCall, listTaskApiCalls, viewApiCall } from '@tulipfarm/api-calls';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';

const route = {
  id: 'api-task',
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
  id: 'api-task',
  mapping: {
    ...initialModelMapping,
    revision: 'api-task',
    families: initialModelMapping.families.filter(f => f.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [route],
});

test('a task change waits for its owner and continues once it is decided', { timeout: 180000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
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
  const user = randomUUID(),
    member = randomUUID(),
    owner = { kind: 'human', userId: user, membershipId: member };
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['rows.list']);
  await createAgentExecutor({ runtime }).configure(
    w.id,
    { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  const prompts = [];
  const answer = (decision, input) => {
    prompts.push(input.prompt);
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
    trustedBundle: () => bundle,
    restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
    allowed: () => true,
    actualModelIds: () => [route.modelId],
    defaultFamily: () => 'claude-opus',
    budgetPicoUsd: () => '10000000000000',
    health: createModelRouteHealth(db.platform, () => 'api-task'),
    infer: async (_resolution, input) =>
      answer(
        prompts.length === 0
          ? {
              kind: 'tool',
              text: 'Closing the ticket.',
              call: {
                tool: 'api.request',
                method: 'PATCH',
                url: 'https://api.example.test/tickets/7',
                body: { kind: 'json', value: { state: 'closed' } },
              },
            }
          : { kind: 'answer', text: 'The ticket was left open.' },
        input,
      ),
  };
  const tasks = createAgentTasks(runtime);
  const engine = createTaskRuntime(runtime, model);
  const task = await tasks.start(w.id, user, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    scope: [],
    text: 'Close ticket 7.',
    limits: { toolCalls: 10, credits: 100, activeMilliseconds: 120000 },
  });
  const settle = async () => {
    for (let n = 0; n < 8 && (await tasks.read(w.id, user, task.id)).status === 'pending'; n++)
      await engine.process(w.id, task.id);
    return (await tasks.read(w.id, user, task.id)).status;
  };

  const first = await settle();
  assert.equal(first, 'waiting-approval');
  const [call] = await runtime.transaction(w.id, commonCompatibility, tx => listTaskApiCalls(tx, owner, task.id));
  assert.equal(call.status, 'awaiting-approval');
  assert.equal(call.method, 'PATCH');
  assert.equal(prompts.length, 1);

  await engine.process(w.id, task.id);
  assert.equal((await tasks.read(w.id, user, task.id)).status, 'waiting-approval', 'an undecided change keeps waiting');
  assert.equal(prompts.length, 1);

  const view = await runtime.transaction(w.id, commonCompatibility, tx => viewApiCall(tx, owner, call.id));
  await withMaintenanceTransaction({
    workspaceId: w.id,
    connectionString: db.login(w, 'confirmation'),
    capability: 'confirmation',
    operation: tx =>
      decideApiCall(tx, owner, call.id, { commandId: randomUUID(), decision: 'reject', digest: view.digest }),
  });
  await engine.process(w.id, task.id);
  assert.equal(await settle(), 'completed');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /rejected/);
  const stored = (
    await db.platform.query(`SELECT status,result FROM ${table('tf_agent_tool_calls')} WHERE id=$1`, [call.id])
  ).rows[0];
  assert.equal(stored.status, 'completed');
  assert.deepEqual([stored.result.status, stored.result.code], ['failed', 'rejected']);
  assert.equal(
    (await runtime.transaction(w.id, commonCompatibility, tx => viewApiCall(tx, owner, call.id))).status,
    'rejected',
  );
});
