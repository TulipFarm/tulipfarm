import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type { TaskProgress } from '@tulipfarm/agents/task-progress';

const legacy = proxyActivities<{ processAgentTask(workspaceId: string, taskId: string): Promise<void> }>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, initialInterval: '1 second', maximumInterval: '10 seconds' },
});
const activities = proxyActivities<{
  processAgentTaskStep(workspaceId: string, taskId: string): Promise<TaskProgress>;
}>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '1 second', maximumInterval: '10 seconds' },
});
const recovery = proxyActivities<{
  discoverAgentTaskWorkspaces(after: string | null): Promise<string[]>;
  recoverAgentTaskPage(workspaceId: string, after?: string): Promise<string | null>;
}>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10 seconds', maximumInterval: '1 minute' },
});

export async function agentTaskRecovery(after: string | null = null): Promise<void> {
  const workspaces = await recovery.discoverAgentTaskWorkspaces(after).catch(() => {
    log.warn('Task workspace discovery will retry');
    return null;
  });
  await Promise.all(
    (workspaces ?? []).map(async workspaceId => {
      try {
        let taskAfter: string | null = null;
        do {
          taskAfter = await recovery.recoverAgentTaskPage(workspaceId, taskAfter ?? undefined);
        } while (taskAfter);
      } catch {
        log.warn('Task recovery will retry', { workspaceId });
      }
    }),
  );
  await sleep('1 minute');
  await continueAsNew<typeof agentTaskRecovery>(
    workspaces ? (workspaces.length === 10 ? (workspaces.at(-1) ?? null) : null) : after,
  );
}

export async function agentTaskStep(workspaceId: string, taskId: string): Promise<void> {
  if (!patched('agent-task-durable-progress-v1')) {
    await legacy.processAgentTask(workspaceId, taskId);
    return;
  }
  const signalWake = patched('agent-task-signal-wake-v1');
  let wakes = 0;
  if (signalWake)
    setHandler(defineSignal('wakeAgentTask'), () => {
      wakes++;
    });
  for (let step = 0; step < 100; step++) {
    const observed = wakes;
    const result = await activities.processAgentTaskStep(workspaceId, taskId);
    if (signalWake && wakes !== observed) continue;
    switch (result.kind) {
      case 'terminal':
        return;
      case 'waiting':
        if (!signalWake) return;
        await condition(() => wakes !== observed);
        break;
      case 'accounting':
      case 'runnable':
        await sleep('2 seconds');
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(`Invalid task progress: ${exhaustive}`);
      }
    }
    if (workflowInfo().continueAsNewSuggested) break;
  }
  await continueAsNew<typeof agentTaskStep>(workspaceId, taskId);
}
