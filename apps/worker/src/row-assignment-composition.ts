import { Runtime } from '@temporalio/worker';
import { createRowAssignments } from '@tulipfarm/agents/row-assignments';
import { createTaskUpkeep } from '@tulipfarm/agents/task-reminders';
import type { createAgentTasks } from '@tulipfarm/agents/tasks';
import { createBackgroundJob } from '@tulipfarm/observability';
import { workspaceSchemaPending } from '@tulipfarm/workspace-storage/runtime';

/** Polls each workspace's row assignments so an assigned agent starts within a few seconds. */
export function createRowAssignmentComposition(options: {
  runtime: Parameters<typeof createRowAssignments>[0]['runtime'];
  agentTasks: ReturnType<typeof createAgentTasks>;
  discover: (after: string | null) => Promise<readonly string[]>;
  wake: (workspaceId: string, taskId: string) => Promise<unknown>;
}) {
  const { agentTasks } = options;
  const engine = createRowAssignments({
    runtime: options.runtime,
    start: (workspaceId, user, value) => agentTasks.startForWorkflow(workspaceId, user, { ...value, sources: [] }),
    pause: async (workspaceId, user, id) => {
      const task = await agentTasks.read(workspaceId, user, id);
      return agentTasks.pause(workspaceId, user, id, { expectedGeneration: task.generation });
    },
    wake: options.wake,
  });
  const upkeep = createTaskUpkeep(options.runtime);
  const job = createBackgroundJob('row-assignments', 15);
  let running: Promise<void> | undefined;
  let sweeps = 0;

  async function sweep() {
    // Welcome tasks and reminders need minute precision, so they run on every tenth sweep, about every 30 seconds.
    const upkeepDue = sweeps++ % 10 === 0;
    const failures: unknown[] = [];
    let after: string | null = null;
    for (;;) {
      const workspaces = await options.discover(after);
      for (const workspaceId of workspaces) {
        try {
          await engine.step(workspaceId);
          if (upkeepDue) await upkeep.step(workspaceId);
        } catch (error) {
          if (!workspaceSchemaPending(error)) failures.push(error);
        }
        after = workspaceId;
      }
      if (workspaces.length < 10) break;
    }
    if (failures.length) throw new AggregateError(failures, 'Row assignment sweep incomplete');
  }

  function tick() {
    if (running) return;
    running = job
      .run(sweep)
      .catch(() => Runtime.instance().logger.error('Row assignment sweep failed'))
      .finally(() => {
        running = undefined;
      });
  }
  const timer = setInterval(tick, 3000);
  timer.unref();
  tick();
  return {
    async close() {
      clearInterval(timer);
      await running;
      job.close();
    },
  };
}
