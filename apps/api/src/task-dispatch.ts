import type { FastifyInstance } from 'fastify';
import type { createTemporalClient } from './temporal.ts';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';

export function taskWake(app: FastifyInstance, temporal: ReturnType<typeof createTemporalClient>) {
  return async (workspaceId: string, taskId: string) => {
    try {
      await temporal.connection.withDeadline(Date.now() + 5000, () =>
        temporal.client.workflow.signalWithStart('agentTaskStep', {
          workflowId: `agent-task-v1-${workspaceId}-${taskId}`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [workspaceId, taskId],
          signal: 'wakeAgentTask',
          signalArgs: [],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        }),
      );
    } catch {
      app.log.error({ workspaceId, taskId }, 'Task dispatch will retry from worker recovery');
    }
  };
}

/** Wakes a plan's scheduler. Its workflow ID and signal match the worker's plan dispatcher. */
export function planWake(app: FastifyInstance, temporal: ReturnType<typeof createTemporalClient>) {
  return async (workspaceId: string, planId: string) => {
    try {
      await temporal.connection.withDeadline(Date.now() + 5000, () =>
        temporal.client.workflow.signalWithStart('agentPlanStep', {
          workflowId: `agent-plan-v1-${workspaceId}-${planId}`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [workspaceId, planId],
          signal: 'wakeAgentPlan',
          signalArgs: [],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        }),
      );
    } catch {
      app.log.error({ workspaceId, planId }, 'Plan dispatch will retry from worker recovery');
    }
  };
}

export function taskActionWake(
  app: FastifyInstance,
  runtime: WorkspaceRuntime,
  wake: ReturnType<typeof taskWake>,
  wakeWorkflow?: (work: { workspaceId: string; runId: string }) => Promise<void>,
) {
  return async (workspaceId: string, actionId: string) => {
    try {
      const tasks = await runtime.transaction(workspaceId, commonCompatibility, async tx =>
        z
          .array(z.object({ task_id: z.uuid() }))
          .parse(
            (
              await tx.client.query(
                `SELECT DISTINCT task_id FROM ${qualified(tx.schema, 'tf_agent_task_steps')} WHERE call_id=$1`,
                [actionId],
              )
            ).rows,
          ),
      );
      for (const task of tasks) await wake(workspaceId, task.task_id);
      if (wakeWorkflow) {
        const runs = await runtime.transaction(workspaceId, commonCompatibility, async tx =>
          tx.commonVersion < 1
            ? []
            : z
                .array(z.object({ run_id: z.uuid() }))
                .parse(
                  (
                    await tx.client.query(
                      `SELECT run_id FROM ${qualified(tx.schema, 'tf_slack_workflow_actions')} WHERE id=$1`,
                      [actionId],
                    )
                  ).rows,
                ),
        );
        for (const run of runs) await wakeWorkflow({ workspaceId, runId: run.run_id });
      }
    } catch {
      app.log.error({ workspaceId, actionId }, 'Task action wake will retry from worker recovery');
    }
  };
}
