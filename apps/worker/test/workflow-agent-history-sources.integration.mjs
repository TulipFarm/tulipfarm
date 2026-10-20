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
  id: 'workflow-agent-history-test',
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
  id: 'workflow-agent-history-test',
  mapping: {
    ...initialModelMapping,
    revision: 'workflow-agent-history-test',
    families: initialModelMapping.families.filter(family => family.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [route],
});

test(
  'sponsored workflow history withholds an agent result from audience members who cannot read its table sources',
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
      const member = async () => {
        const value = { userId: randomUUID(), membershipId: randomUUID() };
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
          value.membershipId,
          value.userId,
        ]);
        return value;
      };
      const sponsor = await member(),
        reader = await member();
      const agent = await savedTaskAgent(
        db,
        workspace,
        runtime,
        workspace.userId,
        workspace.membershipId,
        [],
        ['rows.get'],
      );
      for (const person of [sponsor, reader])
        await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
          person.membershipId,
          agent.teamId,
        ]);
      // The agent's table grant sits on a team without the reader, so only the sponsor's person grant opens the table.
      const agentTeam = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Agent tables')`, [agentTeam]);
      await db.platform.query(
        `INSERT INTO ${table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager')`,
        [workspace.membershipId, agentTeam],
      );
      const field = textField('Secret'),
        revision = 'a'.repeat(40),
        recordId = randomUUID(),
        sentinel = `secret-${randomUUID()}`;
      const { tableId } = await createTableWithRows({
        db,
        workspace,
        runtime,
        revision,
        definition: tableDefinition({ owningTeamId: agentTeam, label: 'Secrets', fields: [field] }),
        records: [{ id: recordId, values: textValues(field, sentinel) }],
      });
      const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
      await db.platform.query(
        `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [agentTeam, tableId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_table_person_grants')} (membership_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [sponsor.membershipId, tableId],
      );
      await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
        agent.activationId,
        JSON.stringify(scope),
      ]);
      await createAgentExecutor({ runtime }).configure(
        workspace.id,
        { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId },
        { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agentTeam], limits: scope },
      );

      const agentTasks = createAgentTasks(runtime);
      const workflows = createWorkflows(runtime, {
        agentTasks: createWorkflowAgentTasks(agentTasks),
        agentResultReadable: agentTasks.resultReadable,
      });
      const workflowId = randomUUID(),
        workflowRevision = randomUUID();
      await workflows.save(workspace.id, sponsor.userId, workflowId, {
        revision: workflowRevision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Report secret',
          trigger: { kind: 'once', at: new Date(Date.now() + 3600000).toISOString() },
          steps: [
            {
              id: 'read',
              kind: 'agent',
              agentId: agent.agentId,
              prompt: { kind: 'literal', value: 'Report the secret.' },
              limits: { toolCalls: 10, activeMilliseconds: 600000, credits: 100 },
            },
            { id: 'copy', kind: 'transform', fields: { copied: { kind: 'step', step: 'read', path: ['result'] } } },
          ],
        },
      });
      await workflows.share(workspace.id, sponsor.userId, workflowId, {
        principal: { kind: 'person', id: reader.membershipId },
        permissions: ['read'],
      });
      await workflows.sponsorship(workspace.id, sponsor.userId, workflowId, {
        sponsorMembershipId: sponsor.membershipId,
        historyAudience: [sponsor.membershipId, reader.membershipId],
      });
      await activate(workflows, workspace.id, sponsor.userId, workflowId, workflowRevision, true);
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [workflowId],
      );
      const [work] = await workflows.due(workspace.id);
      assert.deepEqual(await workflows.advance(work), { kind: 'wait', seconds: 2 });

      const task = (await agentTasks.list(workspace.id, sponsor.userId)).tasks[0];
      const model = {
        activeBundle: () => ({ bundle, activationRevision: 1 }),
        restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
        trustedBundle: () => bundle,
        allowed: () => true,
        actualModelIds: () => [route.modelId],
        health: { claim: async () => true, finish: async () => {} },
        budgetPicoUsd: () => '10000000000000',
        legacyFamily: () => 'claude-opus',
        infer: async (_resolution, input) => {
          const context = JSON.parse(input.prompt);
          const decision = context.results.length
            ? { kind: 'answer', text: `The secret is ${context.results[0].result.values[field.id].value}.` }
            : {
                kind: 'tool',
                text: 'Read the secret.',
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
        attempt < 5 && (await agentTasks.read(workspace.id, sponsor.userId, task.id)).status !== 'completed';
        attempt++
      )
        await engine.process(workspace.id, task.id);
      for (let step = 0; step < 4 && (await workflows.advance(work)).kind !== 'done'; step++);

      const outputs = async person =>
        (await workflows.history(workspace.id, person.userId, workflowId)).runs.flatMap(run =>
          run.steps.map(step => step.output),
        );
      const answer = `The secret is ${sentinel}.`;
      assert.deepEqual(await outputs(sponsor), [{ taskId: task.id, result: answer }, { copied: answer }]);
      const withheld = [{ withheld: 'source-access' }, { withheld: 'source-access' }];
      const readerHistory = await workflows.history(workspace.id, reader.userId, workflowId);
      assert.deepEqual(
        readerHistory.runs.flatMap(run => run.steps.map(step => step.output)),
        withheld,
        'an audience member without table access sees neither the agent result nor its copy',
      );
      assert.ok(!JSON.stringify(readerHistory).includes(sentinel));

      await db.platform.query(
        `INSERT INTO ${table('tf_table_person_grants')} (membership_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [reader.membershipId, tableId],
      );
      assert.deepEqual(await outputs(reader), [{ taskId: task.id, result: answer }, { copied: answer }]);
      await db.platform.query(`DELETE FROM ${table('tf_table_person_grants')} WHERE membership_id=$1 AND asset_id=$2`, [
        reader.membershipId,
        tableId,
      ]);
      assert.deepEqual(
        await outputs(reader),
        withheld,
        'revoking table access withholds the retained result without a rerun',
      );
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
