import { Client, Connection } from '@temporalio/client';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import { createTaskRuntime } from '@tulipfarm/agents/task-runtime';
import { createTaskProgress } from '@tulipfarm/agents/task-progress';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { retryError } from '@tulipfarm/observability';

export function createTaskRecovery(options: {
  runtime: WorkspaceRuntime;
  discover: (after: string | null) => Promise<string[]>;
  wake: (workspaceId: string, taskId: string) => Promise<void>;
  failure: (workspaceId: string, taskId: string) => void;
}) {
  const tasks = createTaskRuntime(options.runtime, null);
  const progress = createTaskProgress(options.runtime);
  return {
    async discoverAgentTaskWorkspaces(after: string | null) {
      try {
        return await options.discover(after);
      } catch (error) {
        throw retryError('task-discovery-unavailable', error);
      }
    },
    async recoverAgentTaskPage(workspaceId: string, after?: string) {
      try {
        const page = await tasks.pending(workspaceId, after);
        for (const taskId of page) {
          try {
            const state = await progress(workspaceId, taskId);
            if (state.kind === 'runnable' || state.kind === 'accounting') await options.wake(workspaceId, taskId);
          } catch {
            options.failure(workspaceId, taskId);
          }
        }
        return page.length === 100 ? (page.at(-1) ?? null) : null;
      } catch (error) {
        throw retryError('task-recovery-unavailable', error);
      }
    },
  };
}

export function createTaskDispatcher(failure: (workspaceId: string, taskId: string) => void) {
  const connection = Connection.lazy(temporalConnectionOptions());
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm';
  const wake = async (workspaceId: string, taskId: string) => {
    try {
      await connection.withDeadline(Date.now() + 5000, () =>
        client.workflow.signalWithStart('agentTaskStep', {
          workflowId: `agent-task-v1-${workspaceId}-${taskId}`,
          taskQueue,
          args: [workspaceId, taskId],
          signal: 'wakeAgentTask',
          signalArgs: [],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        }),
      );
    } catch {
      failure(workspaceId, taskId);
    }
  };
  return {
    wake,
    startRecovery: () =>
      connection.withDeadline(Date.now() + 10000, () =>
        client.workflow.start('agentTaskRecovery', {
          workflowId: 'agent-task-recovery-v1',
          taskQueue,
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        }),
      ),
    close: () => connection.close(),
  };
}
