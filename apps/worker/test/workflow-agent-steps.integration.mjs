import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { createWorkflows } from '@tulipfarm/workflows';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { createAgentExecutor } from '../../../packages/agents/src/executor.ts';
import { createAgentTasks } from '../../../packages/agents/src/tasks.ts';
import { createTaskRuntime } from '../../../packages/agents/src/task-runtime.ts';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../../packages/tables/test/fixture.mjs';
import { activate } from '../../../packages/workflows/test/commands.fixture.mjs';
import { createWorkflowAgentTasks } from '../dist/workflow-agent-tasks.js';

const route = {
  id: 'workflow-agent-test',
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
  id: 'workflow-agent-test',
  mapping: {
    ...initialModelMapping,
    revision: 'workflow-agent-test',
    families: initialModelMapping.families.filter(family => family.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [route],
});

test(
  'workflow agent steps use the activation scope to read an authorized table row through worker composition',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const workspace = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
      });
      const table = name => `"${workspace.names.schema}".${name}`;
      const agent = await savedTaskAgent(
        db,
        workspace,
        runtime,
        workspace.userId,
        workspace.membershipId,
        [],
        ['rows.get'],
      );
      const field = textField(),
        revision = 'a'.repeat(40),
        recordId = randomUUID();
      const { tableId } = await createTableWithRows({
        db,
        workspace,
        runtime,
        revision,
        definition: tableDefinition({ owningTeamId: agent.teamId, label: 'Contacts', fields: [field] }),
        records: [{ id: recordId, values: textValues(field, 'Ada') }],
      });
      const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
      await db.platform.query(
        `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [agent.teamId, tableId],
      );
      await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
        agent.activationId,
        JSON.stringify(scope),
      ]);
      await createAgentExecutor({ runtime }).configure(
        workspace.id,
        { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId },
        { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: scope },
      );

      const agentTasks = createAgentTasks(runtime);
      const workflows = createWorkflows(runtime, {
        agentTasks: createWorkflowAgentTasks(agentTasks),
        agentResultReadable: agentTasks.resultReadable,
      });
      const workflowId = randomUUID(),
        workflowRevision = randomUUID();
      await workflows.save(workspace.id, workspace.userId, workflowId, {
        revision: workflowRevision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Read contact',
          trigger: { kind: 'manual' },
          steps: [
            {
              id: 'read',
              kind: 'agent',
              agentId: agent.agentId,
              prompt: { kind: 'input', path: ['message'] },
              limits: { toolCalls: 10, activeMilliseconds: 600000, credits: 100 },
            },
          ],
        },
      });
      await activate(workflows, workspace.id, workspace.userId, workflowId, workflowRevision, true);
      const run = await workflows.start(workspace.id, workspace.userId, workflowId, {
        requestId: randomUUID(),
        input: { message: 'Read the contact name.' },
      });
      assert.deepEqual(await workflows.advance({ workspaceId: workspace.id, runId: run.runId }), {
        kind: 'wait',
        seconds: 2,
      });

      const task = (await agentTasks.list(workspace.id, workspace.userId)).tasks[0];
      assert.deepEqual(task.scope, scope);
      await db.platform.query(
        `UPDATE ${table('tf_agent_tasks')} SET status='paused',pause_reason='limit.credits' WHERE id=$1`,
        [task.id],
      );
      assert.deepEqual(await createWorkflowAgentTasks(agentTasks).result(workspace.id, workspace.userId, task.id), {
        status: 'paused',
        pauseReason: 'limit.credits',
      });
      await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='pending',pause_reason=NULL WHERE id=$1`, [
        task.id,
      ]);
      const model = {
        activeBundle: () => ({ bundle, activationRevision: 1 }),
        restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
        trustedBundle: () => bundle,
        allowed: () => true,
        actualModelIds: () => [route.modelId],
        health: { claim: async () => true, finish: async () => {} },
        budgetPicoUsd: () => '10000000000000',
        defaultFamily: () => 'claude-opus',
        infer: async (_resolution, input) => {
          const context = JSON.parse(input.prompt);
          const decision = context.results.length
            ? { kind: 'answer', text: `Read ${context.results[0].result.values[field.id].value}.` }
            : {
                kind: 'tool',
                text: 'Read the contact.',
                call: { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId },
              };
          return {
            kind: 'success',
            decision,
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
      const engine = createTaskRuntime(runtime, model);
      for (
        let attempt = 0;
        attempt < 5 && (await agentTasks.read(workspace.id, workspace.userId, task.id)).status !== 'completed';
        attempt++
      )
        await engine.process(workspace.id, task.id);
      const completedTask = await agentTasks.read(workspace.id, workspace.userId, task.id);
      assert.equal(
        completedTask.status,
        'completed',
        JSON.stringify((await agentTasks.history(workspace.id, workspace.userId, task.id)).messages),
      );
      assert.deepEqual(await workflows.advance({ workspaceId: workspace.id, runId: run.runId }), { kind: 'continue' });
      assert.deepEqual(await workflows.advance({ workspaceId: workspace.id, runId: run.runId }), { kind: 'done' });
      const [history] = (await workflows.history(workspace.id, workspace.userId, workflowId)).runs;
      assert.deepEqual(
        history.steps.map(step => step.output),
        [{ taskId: task.id, result: 'Read Ada.' }],
      );
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
