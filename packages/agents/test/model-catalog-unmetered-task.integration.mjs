import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.MODEL_CATALOG_FILE = fileURLToPath(
  new URL('../../config/test/fixtures/model-catalog-unmetered.json', import.meta.url),
);
delete process.env.MODEL_CATALOG;

const { creditGate, unlimitedCredits } = await import('@tulipfarm/extensions');
const { createWorkspaceRuntime } = await import('@tulipfarm/workspace-storage/runtime');
const { workspaceTableMigrations } = await import('@tulipfarm/workspaces/table-migrations');
const { fixture } = await import('../../workspace-storage/test/integration/fixture.mjs');
const { savedTaskAgent } = await import('./task-fixture.mjs');
const { createAgentTasks } = await import('../src/tasks.ts');
const { createTaskRuntime } = await import('../src/task-runtime.ts');
const { createModelRouteHealth } = await import('../src/model-health.ts');
const { createAgentExecutor } = await import('../src/executor.ts');
const { modelEnvironment } = await import('../src/model-environment.ts');

test('a task on an unmetered family runs under the default unlimited credits and records its tokens at zero cost', async t => {
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
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], []);
  await createAgentExecutor({ runtime }).configure(
    w.id,
    { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );

  assert.equal(creditGate(), unlimitedCredits);
  const environment = modelEnvironment({
    MODEL_CATALOG_FILE: process.env.MODEL_CATALOG_FILE,
    AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/',
    AZURE_FOUNDRY_API_KEY: 'synthetic-private-credential',
  });
  const resolutions = [];
  const model = {
    ...environment.continuity(key => createModelRouteHealth(db.platform, key)),
    infer: async resolution => {
      resolutions.push(resolution);
      return {
        kind: 'success',
        decision: { kind: 'answer', text: 'Answered locally.' },
        actualModel: 'Local-Chat-1',
        requestId: randomUUID(),
        usage: {
          kind: 'known',
          input: 1000,
          output: 1000,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        },
      };
    },
  };
  const tasks = createAgentTasks(runtime);
  const task = await tasks.start(w.id, user, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    scope: [],
    text: 'Say hello.',
    limits: { toolCalls: 10, credits: 1000, activeMilliseconds: 600000 },
  });
  const engine = createTaskRuntime(runtime, model);
  for (let n = 0; n < 5 && (await tasks.read(w.id, user, task.id)).status !== 'completed'; n++)
    await engine.process(w.id, task.id);

  const completed = await tasks.read(w.id, user, task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].familyId, 'local-chat');
  assert.equal(resolutions[0].route.deployment, 'Local-Chat-1');
  assert.match(resolutions[0].pricingRevision, /^prices-[0-9a-f]{32}$/);
  assert.equal(completed.cost.chargedCreditUnits, '0');
  const attempts = await db.platform.query(`SELECT usage, cost FROM ${table('tf_model_attempts')}`);
  assert.equal(attempts.rowCount, 1);
  assert.deepEqual(attempts.rows[0].usage, {
    kind: 'known',
    tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  });
  assert.equal(attempts.rows[0].cost.providerPicoUsd, '0');
  const usage = await db.platform.query(
    `SELECT model_id, reserved::text, charged::text FROM ${table('tf_credit_usage')}`,
  );
  assert.deepEqual(usage.rows, [{ model_id: 'local-chat-1', reserved: '0', charged: '0' }]);
  const history = await tasks.history(w.id, user, task.id);
  assert.equal(history.messages.at(-1).text, 'Answered locally.');
});
