import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { grantAgentManager, savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { createAgentExecutor } from '../../../packages/agents/src/executor.ts';
import { createAgentSchedules } from '../../../packages/agents/src/schedules.ts';
import { createAgentTasks } from '../../../packages/agents/src/tasks.ts';
import { createTaskRuntime } from '../../../packages/agents/src/task-runtime.ts';
import { createTaskProgress } from '../../../packages/agents/src/task-progress.ts';
import { createModelRouteHealth } from '../../../packages/agents/src/model-health.ts';

test(
  'a sponsored schedule reaches the real Temporal task workflow with its own prompt exactly once',
  { timeout: 60000 },
  async () => {
    const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
    assert.ok(address, 'Owned Temporal is required');
    const f = await conversationFixture();
    let native, connection;
    try {
      const { id, userId, membershipId } = f.workspace;
      const agent = await savedTaskAgent(f.db, f.workspace, f.runtime, userId, membershipId, [], []);
      await grantAgentManager(f.db, f.workspace, agent.agentId, membershipId);
      await createAgentExecutor({ runtime: f.runtime }).configure(
        id,
        { kind: 'human', userId, membershipId },
        {
          agentId: agent.agentId,
          version: 0,
          enabled: true,
          teamIds: [agent.teamId],
          limits: [],
        },
      );
      const schedules = createAgentSchedules(f.runtime),
        tasks = createAgentTasks(f.runtime);
      const scheduleId = randomUUID(),
        text = 'Prepare the weekly People Ops policy update.';
      await schedules.save(id, userId, agent.agentId, {
        id: scheduleId,
        activationId: agent.activationId,
        sponsorMembershipId: membershipId,
        historyAudience: [],
        action: { kind: 'task', text, limits: { toolCalls: 5, activeMilliseconds: 60000, credits: 100 } },
        trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'Asia/Kolkata' },
      });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_agent_schedules')} SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [scheduleId],
      );
      await schedules.due(id);
      await schedules.due(id);
      const queued = (
        await f.db.platform.query(
          `SELECT id,owner_user_id,owner_membership_id FROM ${f.table('tf_agent_tasks')} WHERE schedule_id=$1`,
          [scheduleId],
        )
      ).rows;
      assert.equal(queued.length, 1);
      assert.equal(queued[0].owner_user_id, userId);
      assert.equal(queued[0].owner_membership_id, membershipId);
      const taskId = queued[0].id;
      const route = {
        id: 'builder-schedule',
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
        id: 'builder-schedule',
        mapping: {
          ...initialModelMapping,
          revision: 'builder-schedule',
          families: initialModelMapping.families.filter(family => family.id === 'claude-opus'),
        },
        models: initialBundleModels,
        routes: [route],
      });
      const prompts = [];
      const model = {
        activeBundle: () => ({ bundle, activationRevision: 1 }),
        restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
        trustedBundle: () => bundle,
        allowed: () => true,
        actualModelIds: () => [route.modelId],
        health: createModelRouteHealth(f.db.platform, () => 'builder-schedule'),
        budgetPicoUsd: () => '10000000000000',
        defaultFamily: () => 'claude-opus',
        infer: async (_resolution, request) => {
          prompts.push(JSON.parse(request.prompt).history.map(message => [message.role, message.text]));
          return {
            kind: 'success',
            decision: { kind: 'answer', text: 'No policy changes need review.' },
            actualModel: route.modelId,
            requestId: randomUUID(),
            usage: {
              kind: 'known',
              input: 10,
              output: 8,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
          };
        },
      };
      const engine = createTaskRuntime(f.runtime, model),
        progress = createTaskProgress(f.runtime);
      native = await NativeConnection.connect({ address });
      connection = await Connection.connect({ address });
      const client = new Client({ connection }),
        taskQueue = randomUUID();
      const workflowsPath = fileURLToPath(new URL('../dist/workflows.js', import.meta.url));
      const worker = await Worker.create({
        connection: native,
        taskQueue,
        workflowsPath,
        activities: {
          processAgentTaskStep: async (workspaceId, currentTaskId) => {
            await engine.process(workspaceId, currentTaskId);
            return progress(workspaceId, currentTaskId);
          },
        },
      });
      await worker.runUntil(async () => {
        const options = {
          workflowId: `agent-builder-${taskId}`,
          taskQueue,
          args: [id, taskId],
          signal: 'wakeAgentTask',
          signalArgs: [],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        };
        const [handle, duplicate] = await Promise.all([
          client.workflow.signalWithStart('agentTaskStep', options),
          client.workflow.signalWithStart('agentTaskStep', options),
        ]);
        assert.equal(handle.signaledRunId, duplicate.signaledRunId);
        await handle.result();
        assert.equal((await tasks.read(id, userId, taskId)).status, 'completed');
        assert.deepEqual(prompts, [[['owner', text]]]);
        assert.deepEqual(
          (await tasks.history(id, userId, taskId)).messages.map(message => [message.role, message.text]),
          [
            ['owner', text],
            ['agent', 'No policy changes need review.'],
          ],
        );
        await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory());
      });
    } finally {
      await connection?.close();
      await native?.close();
      await f.close();
    }
  },
);
